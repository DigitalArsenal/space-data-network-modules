#include "ffm/prw_execution.h"
#include "ffm/prw_codec.h"
#include "ffm/prw_covariance.h"
#include "astrodynamics.h"
#include "integrators.h"
#include "variational.h"
#include "finite_burn.h"
#include "force_partials.h"
#include "ephemeris.h"
#include "environment_models.h"
#include "../../../../../files/orbit-products/src/sha256.hpp"
#include "ffm/prw_dynamics.h"
#include "ffm/kernel_store.h"
// build.mjs defines both from plugin-manifest.json, the manifest the SDK embeds
// as $PLG, so VERSION_QUERY and the PLG identity cannot disagree.
#if !defined(FFM_MODULE_ID) || !defined(FFM_MODULE_VERSION)
#error "FFM_MODULE_ID and FFM_MODULE_VERSION come from plugin-manifest.json; build with build.mjs"
#endif
#include <algorithm>
#include <array>
#include <limits>
extern "C" {
#include "nrlmsise-00.h"
}
#include <cstdio>
#include <memory>

namespace ffm {
namespace {
using namespace astro;
using namespace dynamics;
std::unique_ptr<PRWStateMatrixT> matrix(const double* values,unsigned n,bool covariance) {
    auto out=std::make_unique<PRWStateMatrixT>();out->DIMENSION=n;out->VALUES.resize(n*n);
    for(unsigned i=0;i<n;++i)for(unsigned j=0;j<n;++j)out->VALUES[i*n+j]=values[i*n+j]*(i<6?1000:1)*(covariance?(j<6?1000:1):(j<6?0.001:1));
    return out;
}
// States and matrices leave in the request's axes.
std::unique_ptr<PRWResidentStateT> sampleState(const Execution& execution,const PRWExecutionRequest* request,StateVector state) {
    const auto frame=std::unique_ptr<RFMCoordinateSystemT>(request->INITIAL()->COORDINATE_SYSTEM()->UnPack());
    state.position=toRequestAxes(execution,state.position);state.velocity=toRequestAxes(execution,state.velocity);
    return makeState(state,*frame,request->INITIAL());
}
std::unique_ptr<PRWStateMatrixT> sampleMatrix(const Execution& execution,const double* values,unsigned n,bool covariance) {
    std::vector<double> m(values,values+n*n);rotateMatrix(execution,m.data(),n,true);return matrix(m.data(),n,covariance);
}
bool finish(const Execution& execution,const PRWExecutionRequest* request,const TTEpoch& epochTT,PRWPropagationSampleT& out,std::string& error);
// One epoch integrated from the initial state: finite burns (whose burn state
// runs along the arc) and the plain path without STM or samples.
bool evaluate(Execution& execution,const PRWExecutionRequest* request,const TTEpoch& epochTT,PRWPropagationSampleT& out,std::string& error) {
    const double epoch=timesys::ttToTdb(epochTT.jdTt());
    if(!preflightKernel(execution,epochTT.instant(),error))return false;
    const auto stateOut=[&](StateVector state){return sampleState(execution,request,state);};
    const auto matrixOut=[&](const double* values,unsigned n,bool covariance){return sampleMatrix(execution,values,n,covariance);};
    // Elapsed time on the integration clock (TT), exact to sub-nanosecond.
    const double seconds=elapsedSeconds(execution.initialTT,epochTT);
    if(execution.massDynamics) {
        const auto value=Integrator::PropagateFiniteBurns(execution.initial,execution.mass,seconds,execution.integrator,execution.forces,execution.burns,execution.density,execution.impulses);
        if(!value.success){error="invoke-failed: "+value.errorMessage;return false;}
        auto state=value.finalState;state.epoch=epoch;out.STATE=stateOut(state);out.STATE->HAS_MASS_KG=true;out.STATE->MASS_KG=value.massKg;
        Mat6 phi{};for(int i=0;i<6;++i)for(int j=0;j<6;++j)phi.m[i][j]=value.stm[i*7+j];
        out.STM=matrixOut(&phi.m[0][0],6,false);out.MASS_STM=matrixOut(value.stm.data(),7,false);
        if(execution.covariance){const auto p=Integrator::TransportCovariance(phi,execution.p);out.COVARIANCE=matrixOut(&p.m[0][0],6,true);}
        if(execution.massCovariance){const auto p=Integrator::TransportFiniteCovariance(value.stm,execution.p7);out.MASS_COVARIANCE=matrixOut(p.data(),7,true);}
        out.ACCEPTED_STEPS=value.steps;out.REJECTED_STEPS=value.rejections;
        for(size_t i=0;i<value.burns.size();++i) {
            const auto& burn=value.burns[i];auto report=std::make_unique<PRWBurnReportT>();
            report->BURN_INDEX=i;report->STARTED=burn.started;report->STOPPED=burn.stopped;report->START_BY_EVENT=burn.startByEvent;report->STOP_BY_EVENT=burn.stopByEvent;
            report->HAS_START_SECONDS=burn.started;report->HAS_STOP_SECONDS=burn.stopped;
            if(burn.started){report->START_SECONDS=burn.startSeconds;report->START_EPOCH=makeInstant(execution.initial.epoch+burn.startSeconds/86400);}
            if(burn.stopped){report->STOP_SECONDS=burn.stopSeconds;report->STOP_EPOCH=makeInstant(execution.initial.epoch+burn.stopSeconds/86400);}
            report->DELTA_V_M_S=burn.deltaVKmS*1000;report->PROPELLANT_KG=burn.propellantKg;out.BURNS.push_back(std::move(report));
        }
    } else {
        StateVector state=execution.initial;TTEpoch at=execution.initialTT;uint32_t steps=0,rejections=0;
        if(!propagateState(execution,state,at,epochTT,steps,rejections,error))return false;
        state.epoch=epoch;out.STATE=stateOut(state);out.ACCEPTED_STEPS=steps;out.REJECTED_STEPS=rejections;
    }
    return finish(execution,request,epochTT,out,error);
}
// The tail every sample shares: mass echo, epoch label and finiteness.
bool finish(const Execution& execution,const PRWExecutionRequest* request,const TTEpoch& epochTT,PRWPropagationSampleT& out,std::string& error) {
    if(request->INITIAL()->HAS_MASS_KG()&&!execution.massDynamics){out.STATE->HAS_MASS_KG=true;out.STATE->MASS_KG=execution.mass;}
    out.STATE->STATE->EPOCH=formatTdb(epochTT);out.STATE->STATE->EPOCH_TIME_SYSTEM="TDB";
    if(!Ephemeris::ephemerisError().empty()){error="ephemeris-failed: "+Ephemeris::ephemerisError();return false;}
    for(const auto* m:{out.STM.get(),out.MASS_STM.get(),out.COVARIANCE.get(),out.MASS_COVARIANCE.get()})
        if(m)for(const double value:m->VALUES)if(!std::isfinite(value))
            return prwError(error,"invoke-failed: State matrix transport overflowed its finite SI representation.");
    if(out.STATE->HAS_MASS_KG&&!positive(out.STATE->MASS_KG))
        return prwError(error,"invoke-failed: Propagation returned a nonpositive or nonfinite mass.");
    const auto& state=*out.STATE->STATE;
    if(!std::isfinite(state.POSITION->X)||!std::isfinite(state.POSITION->Y)||!std::isfinite(state.POSITION->Z)||!std::isfinite(state.VELOCITY->X)||!std::isfinite(state.VELOCITY->Y)||!std::isfinite(state.VELOCITY->Z))return prwError(error,"invoke-failed: Integration returned a nonfinite state.");
    return true;
}
bool evaluateInOrder(Execution& execution,const PRWExecutionRequest* request,PRWExecutionResultT& result,std::string& error) {
    // Index 0 is the target epoch, k > 0 the k-th sample.
    std::vector<TTEpoch> epochs{execution.targetTT};
    epochs.insert(epochs.end(),execution.samplesTT.begin(),execution.samplesTT.end());
    std::vector<std::pair<double,size_t>> forward,backward;
    for(size_t k=0;k<epochs.size();++k) {
        const double seconds=elapsedSeconds(execution.initialTT,epochs[k]);
        (seconds<0?backward:forward).push_back({std::abs(seconds),k});
    }
    std::stable_sort(forward.begin(),forward.end());std::stable_sort(backward.begin(),backward.end());
    const unsigned n=6+unsigned(execution.parameters.size());
    std::vector<std::unique_ptr<PRWPropagationSampleT>> samples(epochs.size());
    for(const auto* group:{&forward,&backward}) {
        Cursor c;c.state=execution.initial;c.tt=execution.initialTT;
        c.phi.assign(n*n,0.0);for(unsigned i=0;i<n;++i)c.phi[i*n+i]=1;
        if(execution.covariance)c.p=execution.parameters.empty()?std::vector<double>(&execution.p.m[0][0],&execution.p.m[0][0]+36):execution.pParameters;
        for(const auto& entry:*group) {
            const TTEpoch& epochTT=epochs[entry.second];
            if(!preflightKernel(execution,epochTT.instant(),error))return false;
            if(!advance(execution,c,epochTT,error))return false;
            auto out=std::make_unique<PRWPropagationSampleT>();
            out->STATE=sampleState(execution,request,c.state);out->STM=sampleMatrix(execution,c.phi.data(),n,false);
            if(execution.covariance){out->COVARIANCE=sampleMatrix(execution,c.p.data(),n,true);out->PROCESS_NOISE=prwProcessNoiseRecord(execution.noise);}
            out->ACCEPTED_STEPS=c.steps;out->REJECTED_STEPS=c.rejections;
            if(!finish(execution,request,epochTT,*out,error))return false;
            samples[entry.second]=std::move(out);
        }
    }
    result.FINAL_SAMPLE=std::move(samples[0]);
    for(size_t k=1;k<samples.size();++k)result.SAMPLES.push_back(std::move(samples[k]));
    return true;
}
// Sampled requests without STM, covariance, parameters, impulses or burns:
// the 6-state equations only, epoch by epoch in time order (forward and
// backward of the initial epoch separately), each span integrated once through
// the space-weather breaks. The samples carry no STM. The states agree with
// the variational path's to the integration tolerance (the STM no longer
// enters the step control), at a fraction of its cost.
bool evaluateStatesInOrder(Execution& execution,const PRWExecutionRequest* request,PRWExecutionResultT& result,std::string& error) {
    std::vector<TTEpoch> epochs{execution.targetTT};
    epochs.insert(epochs.end(),execution.samplesTT.begin(),execution.samplesTT.end());
    std::vector<std::pair<double,size_t>> forward,backward;
    for(size_t k=0;k<epochs.size();++k) {
        const double seconds=elapsedSeconds(execution.initialTT,epochs[k]);
        (seconds<0?backward:forward).push_back({std::abs(seconds),k});
    }
    std::stable_sort(forward.begin(),forward.end());std::stable_sort(backward.begin(),backward.end());
    std::vector<std::unique_ptr<PRWPropagationSampleT>> samples(epochs.size());
    for(const auto* group:{&forward,&backward}) {
        StateVector state=execution.initial;TTEpoch at=execution.initialTT;uint32_t steps=0,rejections=0;
        for(const auto& entry:*group) {
            const TTEpoch& epochTT=epochs[entry.second];
            if(!preflightKernel(execution,epochTT.instant(),error))return false;
            if(!propagateState(execution,state,at,epochTT,steps,rejections,error))return false;
            auto out=std::make_unique<PRWPropagationSampleT>();
            out->STATE=sampleState(execution,request,state);
            out->ACCEPTED_STEPS=steps;out->REJECTED_STEPS=rejections;
            if(!finish(execution,request,epochTT,*out,error))return false;
            samples[entry.second]=std::move(out);
        }
    }
    result.FINAL_SAMPLE=std::move(samples[0]);
    for(size_t k=1;k<samples.size();++k)result.SAMPLES.push_back(std::move(samples[k]));
    return true;
}
bool execute(const PRWExecutionRequest* request,const Environment& environment,PRWT& response,std::string& error) {
    Execution execution;if(!parseExecution(request,environment.earth!=nullptr,execution,error))return false;
    if(!attachEnvironment(execution,environment,request->FORCES()->WEATHER()!=nullptr,error))return false;
    auto first=execution.initialTT.instant(),last=execution.targetTT.instant();
    if(first.secondsSince(last)>0)std::swap(first,last);
    for(const auto& t:execution.samplesTT){const auto at=t.instant();if(at.secondsSince(last)>0)last=at;if(at.secondsSince(first)<0)first=at;}
    if(!environmentCovers(execution,environment,first,last,error))return false;
    if(environment.weather&&!execution.massDynamics)execution.breaks=driverBreaks(execution);
    auto result=std::make_unique<PRWExecutionResultT>();
    if(execution.variational&&!execution.massDynamics&&execution.stateOnly) {
        if(!evaluateStatesInOrder(execution,request,*result,error))return false;
    } else if(execution.variational&&!execution.massDynamics) {
        if(!evaluateInOrder(execution,request,*result,error))return false;
    } else {
        // Finite burns carry burn state along the arc; each epoch is integrated
        // from the initial state.
        result->FINAL_SAMPLE=std::make_unique<PRWPropagationSampleT>();
        if(!evaluate(execution,request,execution.targetTT,*result->FINAL_SAMPLE,error))return false;
        for(const auto& epoch:execution.samplesTT){auto sample=std::make_unique<PRWPropagationSampleT>();if(!evaluate(execution,request,epoch,*sample,error))return false;result->SAMPLES.push_back(std::move(sample));}
    }
    result->ELAPSED_SECONDS=elapsedSeconds(execution.initialTT,execution.targetTT);result->EPHEMERIS_SOURCE=Ephemeris::ephemerisSourceName(Ephemeris::selectedEphemerisSource());
    if(execution.variational){result->STM_TECHNIQUE=request->STM_TECHNIQUE();result->DENSITY_TREATMENT=request->DENSITY_TREATMENT();}
    if(request->DYNAMIC_PARAMETERS())for(const auto p:*request->DYNAMIC_PARAMETERS())result->DYNAMIC_PARAMETERS.push_back(p);
    response.EXECUTION_RESULT=std::move(result);return true;
}
// The instance keeps the verified kernel: the same kernel again (same
// SHA-256, identical bytes) is compared, not hashed.
bool loadKernel(const uint8_t* data,size_t size,std::string& error) {
    const auto kernel=instanceKernels().accept(data,size,false,error);
    return kernel&&KernelStore::activate(kernel,error);
}
bool ephemeris(const PRWEphemerisRequest* request,PRWT& response,std::string& error) {
    if(Ephemeris::selectedEphemerisSource()==Ephemeris::EphemerisSource::Analytical)return prwError(error,"missing-kernel: NAIF ephemeris query requires a kernel input.");
    if(request->EPOCH()->TIME_SYSTEM()!=timingStandard::TDB)return prwError(error,"epoch-time-scale: Geometric ephemeris query requires TDB.");
    TTEpoch epoch;if(!decodeEpochTT(request->EPOCH(),epoch,error))return false;
    const auto instant=epoch.instant();const double jd=instant.jdTdb();
    const auto value=Ephemeris::getKernelState(request->TARGET_NAIF_ID(),request->CENTER_NAIF_ID(),instant);
    if(!value.valid){error="ephemeris-failed: "+Ephemeris::ephemerisError();return false;}
    auto result=std::make_unique<PRWEphemerisResultT>();result->TARGET_NAIF_ID=request->TARGET_NAIF_ID();result->CENTER_NAIF_ID=request->CENTER_NAIF_ID();
    StateVector state;state.position=value.position;state.velocity=value.velocity;state.epoch=jd;
    auto frame=makeFrame("ICRF/NAIF-"+std::to_string(request->CENTER_NAIF_ID()),rfmAxisType::ICRF,request->CENTER_NAIF_ID());
    if(request->CENTER_NAIF_ID()>=0&&request->CENTER_NAIF_ID()<=9){frame->ORIGIN->KIND=rfmOriginKind::BARYCENTRE;frame->ORIGIN->BARYCENTRE_ID=request->CENTER_NAIF_ID();frame->ORIGIN->CELESTIAL_BODY_ID=0;}
    result->STATE=makeState(state,*frame);result->EPHEMERIS_SOURCE=Ephemeris::ephemerisSourceName(value.source);response.EPHEMERIS_RESULT=std::move(result);return true;
}
bool atmosphere(const PRWAtmosphereRequest* request,PRWT& response,std::string& error) {
    if(request->EPOCH()->TIME_SYSTEM()!=timingStandard::UTC)return prwError(error,"epoch-time-scale: Atmospheric diagnostic epoch must be UTC.");
    double tdb=0,utc=0;if(!decodeEpoch(request->EPOCH(),tdb,utc,error))return false;
    const double altitude=request->ALTITUDE_M(),lat=request->LATITUDE_RAD(),lon=request->LONGITUDE_RAD();
    if(!nonnegative(altitude)||!std::isfinite(lat)||std::abs(lat)>PI/2||!std::isfinite(lon)||std::abs(lon)>PI||!nonnegative(request->F107())||!nonnegative(request->F107_AVERAGE())||!nonnegative(request->AP_INDEX()))
        return prwError(error,"invalid-atmosphere: Atmosphere inputs must be finite and within their physical domain.");
    if(!request->HAS_LOCAL_SOLAR_TIME_HOURS()&&request->LOCAL_SOLAR_TIME_HOURS()!=0)return prwError(error,"invalid-presence: Local solar time requires its presence bit.");
    if(request->HAS_LOCAL_SOLAR_TIME_HOURS()&&(!nonnegative(request->LOCAL_SOLAR_TIME_HOURS())||request->LOCAL_SOLAR_TIME_HOURS()>=24))return prwError(error,"invalid-atmosphere: Local solar time must be in [0,24).");
    auto result=std::make_unique<PRWAtmosphereResultT>();result->ATMOSPHERE_MODEL=request->ATMOSPHERE_MODEL();result->ALTITUDE_M=altitude;
    if(request->ATMOSPHERE_MODEL()==prwAtmosphereFamily::USSA1976) {
        if(altitude>86000)return prwError(error,"unsupported-atmosphere: USSA1976 profile covers 0 to 86 km geometric altitude.");
        if(request->INCLUDE_ANOMALOUS_OXYGEN())return prwError(error,"unsupported-atmosphere: Anomalous oxygen is an NRLMSISE00 option.");
        const auto value=computeUSSA1976(altitude*0.001);result->DENSITY_KG_M3=value.density;result->HAS_TEMPERATURE_K=true;result->TEMPERATURE_K=value.temperature;result->HAS_SCALE_HEIGHT_M=true;result->SCALE_HEIGHT_M=value.scaleHeight*1000;
    } else if(request->ATMOSPHERE_MODEL()==prwAtmosphereFamily::EXPONENTIAL) {
        if(request->INCLUDE_ANOMALOUS_OXYGEN())return prwError(error,"unsupported-atmosphere: Anomalous oxygen is an NRLMSISE00 option.");
        result->DENSITY_KG_M3=exponentialAtmosphereDensity(altitude*0.001);
    } else if(request->ATMOSPHERE_MODEL()==prwAtmosphereFamily::NRLMSISE00) {
        nrlmsise_input input{};nrlmsise_flags flags{};nrlmsise_output value{};
        int month=0,day=0,hour=0,minute=0;double seconds=0;
        timesys::Epoch(utc,timesys::TimeScale::UTC).toComponents(input.year,month,day,hour,minute,seconds);
        input.doy=int(std::floor(utc-timesys::Epoch::fromComponents(input.year,1,1,0,0,0,timesys::TimeScale::UTC).jd))+1;
        input.sec=hour*3600+minute*60+seconds;input.alt=altitude*0.001;input.g_lat=lat*180/PI;input.g_long=lon*180/PI;
        input.lst=request->HAS_LOCAL_SOLAR_TIME_HOURS()?request->LOCAL_SOLAR_TIME_HOURS():std::fmod(input.sec/3600+input.g_long/15+24,24);
        input.f107=request->F107();input.f107A=request->F107_AVERAGE();input.ap=request->AP_INDEX();
        flags.switches[0]=0;for(int i=1;i<24;++i)flags.switches[i]=1;
        if(request->INCLUDE_ANOMALOUS_OXYGEN())gtd7d(&input,&flags,&value);else gtd7(&input,&flags,&value);
        result->VARIANT=request->INCLUDE_ANOMALOUS_OXYGEN()?"gtd7d":"gtd7";result->DENSITY_KG_M3=value.d[5]*1000;result->HAS_TEMPERATURE_K=true;result->TEMPERATURE_K=value.t[1];result->HAS_EXOSPHERIC_TEMPERATURE_K=true;result->EXOSPHERIC_TEMPERATURE_K=value.t[0];
        const int indices[]={0,1,2,3,4,6,7,8};
        for(int i=0;i<8;++i){auto species=std::make_unique<PRWSpeciesDensityT>();species->CONSTITUENT=static_cast<prwDensitySpecies>(i+1);species->NUMBER_PER_M3=value.d[indices[i]]*1e6;result->NUMBER_DENSITIES.push_back(std::move(species));}
    } else return prwError(error,"unsupported-atmosphere: Diagnostic supports NRLMSISE00, USSA1976 and EXPONENTIAL.");
    if(!nonnegative(result->DENSITY_KG_M3))return prwError(error,"invoke-failed: Atmosphere returned an invalid density.");
    response.ATMOSPHERE_RESULT=std::move(result);return true;
}
} // namespace
bool processPrwInvoke(const uint8_t* data,size_t size,const uint8_t* kernel,size_t kernelSize,const PrwEnvironment& frames,std::vector<uint8_t>& output,std::string& error) {
    struct KernelLifetime {KernelLifetime(){Ephemeris::clearEphemerisBuffer();}~KernelLifetime(){Ephemeris::clearEphemerisBuffer();}} kernelLifetime;
    const PRW* request=nullptr;if(!verifyPrw(data,size,request,error))return false;
    if(kernelSize&&!loadKernel(kernel,kernelSize,error))return false;
    PRWT response;bool ok=false;
    // The rows point into these PRW buffers, which outlive the invocation.
    Environment environment;
    if(!loadEnvironment(frames,false,environment,error))return false;
    if(request->EXECUTION_REQUEST()){
        astro::clearCallStop();
        ok=execute(request->EXECUTION_REQUEST(),environment,response,error);
        // The trajectory ended (lib/reentry.h): the request fails there, by name.
        if(astro::callStop().active){error=std::string(astro::callStop().code)=="invalid-force" ? astro::propagationStopMessage(astro::callStop()) : stopError(astro::callStop());return false;}
    }
    else if(environment.earth)return prwError(error,"unsupported-earth-orientation: Earth orientation applies to execution requests.");
    else if(environment.jb2008)return prwError(error,"unsupported-jb2008-indices: JB2008 indices apply to execution requests.");
    else if(environment.weather)return prwError(error,"unsupported-space-weather: Space weather applies to execution requests.");
    else if(request->EPHEMERIS_REQUEST())ok=ephemeris(request->EPHEMERIS_REQUEST(),response,error);
    else if(request->ATMOSPHERE_REQUEST())ok=atmosphere(request->ATMOSPHERE_REQUEST(),response,error);
    else if(request->VERSION_QUERY()){response.VERSION_RESULT=std::make_unique<PRWVersionResultT>();response.VERSION_RESULT->VERSION=FFM_MODULE_VERSION;response.VERSION_RESULT->MODULE_ID=FFM_MODULE_ID;ok=true;}
    else return prwError(error,"invalid-prw-arm: invoke requires execution, ephemeris, atmosphere or version query.");
    if(ok)encodePrw(response,output);return ok;
}
} // namespace ffm
