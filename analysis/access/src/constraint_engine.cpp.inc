// ACW 1.219 constraint engine. All positions are Earth-fixed metres; the
// numerical solver uses seconds from the first TT sample, avoiding JD loss.
// Linear interpolation is the only interpolation justified by position-only
// ACW samples. No extrapolation or ephemeris fallback is permitted.
#include "constraint_polynomials.hpp"
struct ConstraintObserver {
  std::string station_id, observer_id;
  bool ground = false;
  StoredGroundStation station{};
  std::vector<StateRecord> states;
  std::vector<BlackoutWindowRecord> blackouts;
};
struct ConstraintLeaf {
  const ACWConstraint* record;
  ElevationMaskTable mask;
};
struct ConstraintNode {
  bool any = false;
  std::vector<size_t> leaves;
  std::vector<ConstraintNode> children;
};
struct ConstraintEngine {
  std::vector<StateRecord> target, sun, moon;
  std::vector<ConstraintLeaf> leaves;
  std::vector<std::string> labels;
  ConstraintNode tree;
  RefractionModelRecord refraction{};
  bool has_refraction = false;
  double epoch = 0, duration = 0, tolerance = 0.1;

  static Vec3 sub(Vec3 a, Vec3 b) { return {a.x-b.x,a.y-b.y,a.z-b.z}; }
  static Vec3 at(const std::vector<StateRecord>& states, double t) {
    auto upper = std::upper_bound(states.begin(), states.end(), t,
        [](double value, const StateRecord& state) { return value < state.julian_date; });
    if (upper == states.begin()) return {upper->x,upper->y,upper->z};
    if (upper == states.end()) return {states.back().x,states.back().y,states.back().z};
    const auto& a = *(upper-1); const auto& b = *upper;
    const double u = (t-a.julian_date)/(b.julian_date-a.julian_date);
    return {a.x+u*(b.x-a.x),a.y+u*(b.y-a.y),a.z+u*(b.z-a.z)};
  }
  bool series(const flatbuffers::Vector<flatbuffers::Offset<ACWStateSample>>* input,
      std::vector<StateRecord>& output, std::string& error) {
    if (!parseAcwStates(input, &output, &error)) return false;
    for (size_t i=0;i<output.size();++i) {
      output[i].julian_date = (output[i].julian_date-epoch)*86400.0;
      if (i && !(output[i].julian_date > output[i-1].julian_date)) {
        error="ACW sample epochs must be strictly increasing."; return false;
      }
    }
    if (output.front().julian_date > 0 || output.back().julian_date < duration) {
      error="ACW observer/body samples must cover the complete target interval."; return false;
    }
    return true;
  }
  bool parseSet(const ACWConstraintSet* set, ConstraintNode& out, std::string& error, int depth=0) {
    if (!set || depth>32 || leaves.size()>4096) { error="ACW constraint tree exceeds supported depth/size."; return false; }
    if (set->OPERATOR()!=acwConstraintOperator_ALL_OF && set->OPERATOR()!=acwConstraintOperator_ANY_OF) {
      error="ACW constraint operator is invalid."; return false;
    }
    out.any=set->OPERATOR()==acwConstraintOperator_ANY_OF;
    if (set->CONSTRAINTS()) for (const auto* record : *set->CONSTRAINTS()) {
      if (!record) { error="ACW constraint is missing."; return false; }
      ConstraintLeaf leaf{record,{}};
      switch (record->KIND()) {
        case acwConstraintKind_MIN_ELEVATION:
          if (!isFinite(record->THRESHOLD_RAD()) || std::abs(record->THRESHOLD_RAD())>kPi/2) { error="Invalid elevation threshold."; return false; } break;
        case acwConstraintKind_ELEVATION_MASK:
          if (!parseAcwElevationMask(record->MASK(),&leaf.mask,&error)) return false;
          for (const auto& p:leaf.mask.points) if (std::abs(p.elevation_rad)>kPi/2) { error="Invalid mask elevation."; return false; } break;
        case acwConstraintKind_MAX_RANGE:
          if (!isFinite(record->MAX_RANGE_M()) || record->MAX_RANGE_M()<0) { error="Invalid maximum range."; return false; } break;
        case acwConstraintKind_MIN_RANGE:
          if (!isFinite(record->MIN_RANGE_M()) || record->MIN_RANGE_M()<0) { error="Invalid minimum range."; return false; } break;
        case acwConstraintKind_SUN_EXCLUSION: case acwConstraintKind_MOON_EXCLUSION:
          if (!isFinite(record->THRESHOLD_RAD()) || record->THRESHOLD_RAD()<0 || record->THRESHOLD_RAD()>kPi) { error="Invalid exclusion angle."; return false; } break;
        case acwConstraintKind_TARGET_LIGHTING:
          if (record->LIGHTING()<acwLightingCondition_ANY || record->LIGHTING()>acwLightingCondition_NOT_UMBRA) { error="Invalid target lighting condition."; return false; } break;
        case acwConstraintKind_LINE_OF_SIGHT:
          if (!isFinite(record->OCCULTATION_ATMOSPHERE_HEIGHT_M()) || record->OCCULTATION_ATMOSPHERE_HEIGHT_M()<0) { error="Invalid occultation atmosphere height."; return false; } break;
        case acwConstraintKind_BLACKOUT: break;
        default: error="Unsupported ACW constraint kind."; return false;
      }
      out.leaves.push_back(leaves.size()); leaves.push_back(std::move(leaf));
      labels.push_back(flatbufferString(record->LABEL()));
    }
    if (set->SETS()) for (const auto* child : *set->SETS()) {
      out.children.emplace_back();
      if (!parseSet(child,out.children.back(),error,depth+1)) return false;
    }
    return true;
  }
  static bool aggregate(const ConstraintNode& node, const std::vector<double>& values) {
    bool result=!node.any;
    for (auto index:node.leaves) { const bool ok=values[index]>=0; if (node.any) result=result||ok; else result=result&&ok; }
    for (const auto& child:node.children) { const bool ok=aggregate(child,values); if (node.any) result=result||ok; else result=result&&ok; }
    return result;
  }
  int attribution(const std::vector<double>& before,const std::vector<double>& after) const {
    const bool oldVisible=aggregate(tree,before),newVisible=aggregate(tree,after);
    if(oldVisible==newVisible)return -1;
    auto state=after;
    // Counterfactual at the resulting state excludes unrelated transitions.
    // Simultaneous sufficient causes use the first depth-first index.
    for(size_t i=0;i<after.size();++i)if((before[i]>=0)!=(after[i]>=0)){
      state[i]=before[i];const bool relevant=aggregate(tree,state)!=newVisible;state[i]=after[i];
      if(relevant)return static_cast<int>(i);
    }
    // Redundant simultaneous OR branches may have no individual necessary
    // cause. Deterministically identify the transition in depth-first order.
    state=before;
    for(size_t i=0;i<after.size();++i){state[i]=after[i];if(aggregate(tree,state)!=oldVisible)return static_cast<int>(i);}
    return -1;
  }
  Vec3 observerAt(const ConstraintObserver& observer,double t) const {
    return observer.ground ? geodeticToEcef(observer.station.latitude_rad,observer.station.longitude_rad,observer.station.altitude_m) : at(observer.states,t);
  }
  double range(const ConstraintObserver& observer,double t) const {
    const auto los=sub(at(target,t),observerAt(observer,t)); return std::sqrt(dot(los,los));
  }
  double elevation(const ConstraintObserver& observer,double t) const {
    if (!observer.ground) return 0; // no local vertical is defined for spacecraft
    const auto pos=at(target,t); const auto& s=observer.station;
    const double result=computeAccessGeometryRad(observerAt(observer,t),geodeticEast(s.longitude_rad),
        geodeticNorth(s.latitude_rad,s.longitude_rad),geodeticUp(s.latitude_rad,s.longitude_rad),
        {t,pos.x,pos.y,pos.z}).elevation_rad;
    return isFinite(result)?result:-kPi/2;
  }
  static int32_t bodyAt(void* context,int32_t id,double t,double out[3]) {
    auto* self=static_cast<const ConstraintEngine*>(context);
    const Vec3 pos=id==399?Vec3{0,0,0}:at(self->sun,t);
    out[0]=pos.x;out[1]=pos.y;out[2]=pos.z;return 0;
  }
  bool value(const ConstraintObserver& observer,size_t index,double t,double& out) const {
    const auto& leaf=leaves[index];const auto* c=leaf.record;
    const auto origin=observerAt(observer,t), targetPos=at(target,t),los=sub(targetPos,origin);
    const double r=std::sqrt(dot(los,los));
    switch(c->KIND()) {
      case acwConstraintKind_MIN_ELEVATION: case acwConstraintKind_ELEVATION_MASK: {
        if (!observer.ground || !(r>0)) return false;
        const auto& s=observer.station;
        const auto geom=computeAccessGeometryRad(origin,geodeticEast(s.longitude_rad),geodeticNorth(s.latitude_rad,s.longitude_rad),geodeticUp(s.latitude_rad,s.longitude_rad),{t,targetPos.x,targetPos.y,targetPos.z});
        const double threshold=c->KIND()==acwConstraintKind_MIN_ELEVATION?c->THRESHOLD_RAD():evaluateElevationMask(leaf.mask,geom.azimuth_rad);
        out=geom.elevation_rad+computeRefractionRad(geom.elevation_rad,has_refraction?&refraction:nullptr)-threshold;break;
      }
      case acwConstraintKind_MAX_RANGE: out=c->MAX_RANGE_M()-r;break;
      case acwConstraintKind_MIN_RANGE: out=r-c->MIN_RANGE_M();break;
      case acwConstraintKind_SUN_EXCLUSION: case acwConstraintKind_MOON_EXCLUSION: {
        const auto body=sub(at(c->KIND()==acwConstraintKind_SUN_EXCLUSION?sun:moon,t),origin);
        const double b=std::sqrt(dot(body,body));if (!(r>0&&b>0)) return false;
        const Vec3 cross{los.y*body.z-los.z*body.y,los.z*body.x-los.x*body.z,los.x*body.y-los.y*body.x};
        out=std::atan2(std::sqrt(dot(cross,cross)),dot(los,body))-c->THRESHOLD_RAD();break;
      }
      case acwConstraintKind_TARGET_LIGHTING: {
        if (c->LIGHTING()==acwLightingCondition_ANY) {out=1;break;}
        sdn::events::EclipseContext eclipse;
        eclipse.bodyPosition=bodyAt;eclipse.bodyContext=const_cast<ConstraintEngine*>(this);
        const double state[]{targetPos.x,targetPos.y,targetPos.z,0,0,0}; double penumbra=0,umbra=0;
        if(sdn::events::eclipseFunction(&eclipse,t,state,&penumbra)!=0)return false;
        eclipse.region=sdn::events::ShadowRegion::UMBRA;
        if(sdn::events::eclipseFunction(&eclipse,t,state,&umbra)!=0)return false;
        switch(c->LIGHTING()) {
          case acwLightingCondition_SUNLIT:out=penumbra;break;
          case acwLightingCondition_UMBRA:out=-umbra;break;
          case acwLightingCondition_PENUMBRA:out=std::min(-penumbra,umbra);break;
          default:out=umbra;break;
        }break;
      }
      case acwConstraintKind_LINE_OF_SIGHT: {
        const double h=c->OCCULTATION_ATMOSPHERE_HEIGHT_M(),a=kWgs84A+h,b=kWgs84A*std::sqrt(1-kWgs84E2)+h;
        const Vec3 p{origin.x/a,origin.y/a,origin.z/b},d{los.x/a,los.y/a,los.z/b};
        const double q=dot(d,d);const double u=q>0?clampFraction(-dot(p,d)/q):0;
        const Vec3 closest{p.x+u*d.x,p.y+u*d.y,p.z+u*d.z};out=dot(closest,closest)-1;break;
      }
      case acwConstraintKind_BLACKOUT:
        out=1;
        for(const auto& blackout:observer.blackouts) if(t>=blackout.start_julian_date&&t<blackout.end_julian_date){out=-1;break;}break;
      default:return false;
    }
    return isFinite(out);
  }
  bool values(const ConstraintObserver& observer,double t,std::vector<double>& out) const {
    out.resize(leaves.size());for(size_t i=0;i<leaves.size();++i)if(!value(observer,i,t,out[i]))return false;return true;
  }
  std::vector<double> knots(const ConstraintObserver& observer,double start,double end) const {
    std::vector<double> result{start,end};
    for(const auto* series:{&target,&observer.states,&sun,&moon})for(const auto& s:*series)if(s.julian_date>start&&s.julian_date<end)result.push_back(s.julian_date);
    std::sort(result.begin(),result.end());result.erase(std::unique(result.begin(),result.end()),result.end());return result;
  }
  void summarize(const ConstraintObserver& observer,double start,double end,AcwWindowWithStation& window,bool discrete) const {
    window.station_id=observer.station_id;window.observer_id=observer.observer_id;
    window.window={epoch+start/86400,epoch+end/86400,0,0,0};
    window.min_range=std::numeric_limits<double>::infinity();window.max_range=0;
    window.window.max_elevation_rad=observer.ground?-kPi/2:0;
    auto include=[&](double t){const double r=range(observer,t);window.min_range=std::min(window.min_range,r);window.max_range=std::max(window.max_range,r);window.window.max_elevation_rad=std::max(window.window.max_elevation_rad,elevation(observer,t));};
    std::vector<double> vals;
    for(const auto& state:target)if(state.julian_date>=start&&state.julian_date<=end){
      if(values(observer,state.julian_date,vals)&&aggregate(tree,vals)){++window.window.sample_count;if(discrete)include(state.julian_date);}
    }
    if(discrete)return;
    auto samples=knots(observer,start,end);
    for(double t:samples)include(t);
    for(size_t i=1;i<samples.size();++i){
      const double a=samples[i-1],b=samples[i];
      const Vec3 p=sub(at(target,a),observerAt(observer,a)),q=sub(at(target,b),observerAt(observer,b)),d=sub(q,p);
      const double dd=dot(d,d);
      if(dd>0){double u=-dot(p,d)/dd;if(u>0&&u<1)include(a+u*(b-a));}
      if(observer.ground){const auto up=geodeticUp(observer.station.latitude_rad,observer.station.longitude_rad);
        const double n=dot(up,d)*dot(p,p)-dot(up,p)*dot(p,d),den=dot(up,d)*dot(p,d)-dot(up,p)*dd;
        if(den!=0){const double u=-n/den;if(u>0&&u<1)include(a+u*(b-a));}}
    }
  }
  bool windows(const ConstraintObserver& observer,bool continuous,std::vector<AcwWindowWithStation>& result,std::string& error) const {
    std::vector<double> vals,previous;
    auto okAt=[&](double t,bool& ok){if(!values(observer,t,vals)){error="ACW constraint geometry is undefined at an evaluated epoch.";return false;}ok=aggregate(tree,vals);return true;};
    if(!continuous){
      bool active=false;double start=0,end=0;int begin=-1,finish=-1;
      for(size_t i=0;i<target.size();++i){bool ok=false;if(!okAt(target[i].julian_date,ok))return false;
        auto changed=[&](){return attribution(previous,vals);};
        if(ok&&!active){start=target[i].julian_date;begin=i?changed():-1;active=true;}
        if(!ok&&active){finish=changed();AcwWindowWithStation w;summarize(observer,start,end,w,true);w.start_constraint=begin;w.end_constraint=finish;
          if(begin>=0)w.start_label=labels[begin];if(finish>=0)w.end_label=labels[finish];result.push_back(std::move(w));active=false;}
        if(ok)end=target[i].julian_date;previous=vals;
      }
      if(active){AcwWindowWithStation w;summarize(observer,start,end,w,true);w.start_constraint=begin;if(begin>=0)w.start_label=labels[begin];result.push_back(std::move(w));}return true;
    }
    struct Edge{double t;int index;};std::vector<Edge> edges{{0,-1},{duration,-1}};
    const auto samples=knots(observer,0,duration);
    for(size_t leaf=0;leaf<leaves.size();++leaf){
      if(leaves[leaf].record->KIND()==acwConstraintKind_BLACKOUT){
        for(const auto& b:observer.blackouts)for(double t:{b.start_julian_date,b.end_julian_date})if(t>0&&t<duration)edges.push_back({t,static_cast<int>(leaf)});continue;}
      for(size_t i=1;i<samples.size();++i){
        // Each leaf is bracketed independently, retaining transitions hidden
        // by the other members of an AND/OR set. Algebraic roots partition
        // angular/limb/shadow geometries, including short interior intervals.
        std::vector<double> scan{samples[i-1],samples[i]};
        for(int n=1;n<16;++n)scan.push_back(samples[i-1]+(samples[i]-samples[i-1])*n/16.0);
        const double start=samples[i-1],end=samples[i];
        const auto o0=observerAt(observer,start),o1=observerAt(observer,end);
        const auto t0=at(target,start),t1=at(target,end);
        const auto p=sub(t0,o0),p1=sub(t1,o1),d=sub(p1,p);
        if(dot(d,d)>0){const double u=-dot(p,d)/dot(d,d);if(u>0&&u<1)scan.push_back(samples[i-1]+u*(samples[i]-samples[i-1]));}
        auto vector=[](Vec3 v){return acw_polynomial::Vector{v.x,v.y,v.z};};
        auto add=[&](const std::vector<double>& roots){for(double u:roots)if(u>0&&u<1)scan.push_back(start+u*(end-start));};
        const auto* c=leaves[leaf].record;
        if(c->KIND()==acwConstraintKind_SUN_EXCLUSION||c->KIND()==acwConstraintKind_MOON_EXCLUSION){
          const auto& body=c->KIND()==acwConstraintKind_SUN_EXCLUSION?sun:moon;
          add(acw_polynomial::angularRoots(vector(p),vector(p1),vector(sub(at(body,start),o0)),vector(sub(at(body,end),o1)),c->THRESHOLD_RAD()));
        }else if(c->KIND()==acwConstraintKind_MIN_ELEVATION&&!has_refraction){
          const auto up=vector(geodeticUp(observer.station.latitude_rad,observer.station.longitude_rad));
          add(acw_polynomial::angularRoots(vector(p),vector(p1),up,up,kPi/2-c->THRESHOLD_RAD()));
        }else if(c->KIND()==acwConstraintKind_LINE_OF_SIGHT){
          const double h=c->OCCULTATION_ATMOSPHERE_HEIGHT_M();
          add(acw_polynomial::limbRoots(vector(o0),vector(o1),vector(t0),vector(t1),kWgs84A+h,kWgs84A*std::sqrt(1-kWgs84E2)+h));
        }else if(c->KIND()==acwConstraintKind_TARGET_LIGHTING&&c->LIGHTING()!=acwLightingCondition_ANY){
          const auto earth0=vector(sub({0,0,0},t0)),earth1=vector(sub({0,0,0},t1));
          const auto sun0=vector(sub(at(sun,start),t0)),sun1=vector(sub(at(sun,end),t1));
          add(acw_polynomial::lightingRoots(earth0,earth1,sun0,sun1,kWgs84A,6.957e8,true));
          add(acw_polynomial::lightingRoots(earth0,earth1,sun0,sun1,kWgs84A,6.957e8,false));
        }
        if(c->KIND()==acwConstraintKind_ELEVATION_MASK){
          const auto east=geodeticEast(observer.station.longitude_rad),north=geodeticNorth(observer.station.latitude_rad,observer.station.longitude_rad),up=geodeticUp(observer.station.latitude_rad,observer.station.longitude_rad);
          for(const auto& point:leaves[leaf].mask.points){
            const double a=dot(p,east)*std::cos(point.azimuth_rad)-dot(p,north)*std::sin(point.azimuth_rad);
            const double b=dot(d,east)*std::cos(point.azimuth_rad)-dot(d,north)*std::sin(point.azimuth_rad);
            if(b!=0){const double u=-a/b;if(u>0&&u<1)scan.push_back(start+u*(end-start));}
          }
          const auto& points=leaves[leaf].mask.points;
          for(size_t j=1;j<points.size();++j){
            const double slope=(points[j].elevation_rad-points[j-1].elevation_rad)/(points[j].azimuth_rad-points[j-1].azimuth_rad);
            add(acw_polynomial::maskStationaryRoots(vector(p),vector(p1),vector(up),vector(east),vector(north),slope));
          }
        }
        std::sort(scan.begin(),scan.end());
        scan.erase(std::unique(scan.begin(),scan.end()),scan.end());
        const size_t boundaryCount=scan.size();
        for(size_t j=1;j<boundaryCount;++j)scan.push_back((scan[j-1]+scan[j])/2);
        std::sort(scan.begin(),scan.end());
        for(size_t j=1;j<scan.size();++j){double ga=0,gb=0;
          if(!value(observer,leaf,scan[j-1],ga)||!value(observer,leaf,scan[j],gb)){error="ACW constraint geometry is undefined within target coverage.";return false;}
          if(ga==0)edges.push_back({scan[j-1],static_cast<int>(leaf)});
          if(gb==0)edges.push_back({scan[j],static_cast<int>(leaf)});
          if((ga<0&&gb>0)||(ga>0&&gb<0)){double root=0;
            if(!sdn::events::brentRoot([&](double t,double* g){return value(observer,leaf,t,*g);},scan[j-1],scan[j],ga,gb,tolerance*0.25,100,&root,nullptr,nullptr)){error="ACW edge refinement did not converge.";return false;}
            edges.push_back({root,static_cast<int>(leaf)});}
        }
      }
    }
    std::sort(edges.begin(),edges.end(),[](const Edge&a,const Edge&b){return a.t==b.t?a.index<b.index:a.t<b.t;});
    // Collapse only floating-point duplicates, never intervals shorter than
    // the requested root tolerance. Ties select the first depth-first leaf.
    std::vector<Edge> unique;for(const auto& e:edges){if(!unique.empty()&&std::abs(unique.back().t-e.t)<1e-8){unique.back().index=std::min(unique.back().index,e.index);}else unique.push_back(e);}
    bool active=false;double start=0;int begin=-1;
    auto emit=[&](double end,int finish){AcwWindowWithStation w;summarize(observer,start,end,w,false);w.refined=true;w.start_constraint=begin;w.end_constraint=finish;
      if(begin>=0)w.start_label=labels[begin];if(finish>=0)w.end_label=labels[finish];result.push_back(std::move(w));};
    for(size_t i=1;i<unique.size();++i){bool ok=false;if(!okAt((unique[i-1].t+unique[i].t)/2,ok))return false;
      if(ok&&!active){start=unique[i-1].t;begin=i==1?-1:attribution(previous,vals);active=true;}
      if(!ok&&active){emit(unique[i-1].t,attribution(previous,vals));active=false;}
      previous=vals;}
    if(active)emit(duration,-1);return true;
  }
};

std::vector<uint8_t> dispatchConstrainedAccess(const ACWRequest& request,uint64_t pivTraceId){
  ConstraintEngine engine;std::vector<AcwWindowWithStation> windows;std::string error;
  const auto mode=request.EVALUATION_MODE();
  auto finish=[&](bool ok){const auto payload=serializeAcwResultPayload(ok?acwResultStatus_OK:acwResultStatus_INVALID_INPUT,
      ok?windows:std::vector<AcwWindowWithStation>{},flatbufferString(request.TRACE_ID()),ok?nullptr:error.c_str(),mode,engine.labels);return serializeInvokeSuccessWithAcwPayload(payload,pivTraceId);};
  if(!request.STATES()||request.STATES()->size()<2){error="ACW requires at least two target samples.";return finish(false);}
  if(!request.STATES()->Get(0)){error="ACW target sample is missing.";return finish(false);}
  engine.epoch=request.STATES()->Get(0)->JULIAN_DATE_TT();
  if(!engine.series(request.STATES(),engine.target,error))return finish(false);
  engine.duration=engine.target.back().julian_date;
  engine.tolerance=request.ROOT_TOLERANCE_S();
  if((mode!=acwEvaluationMode_DISCRETE&&mode!=acwEvaluationMode_CONTINUOUS)||!isFinite(engine.tolerance)||engine.tolerance<=0){error="ACW evaluation mode or root tolerance is invalid.";return finish(false);}
  if(!engine.parseSet(request.CONSTRAINTS(),engine.tree,error))return finish(false);
  if(!parseAcwRefractionModel(request.REFRACTION_MODEL(),&engine.refraction,&engine.has_refraction,&error))return finish(false);
  bool needSun=false,needMoon=false,needGround=false;
  for(const auto& leaf:engine.leaves){const auto kind=leaf.record->KIND();needSun|=kind==acwConstraintKind_SUN_EXCLUSION||kind==acwConstraintKind_TARGET_LIGHTING;
    needMoon|=kind==acwConstraintKind_MOON_EXCLUSION;needGround|=kind==acwConstraintKind_MIN_ELEVATION||kind==acwConstraintKind_ELEVATION_MASK;}
  if(needSun&&!engine.series(request.SUN_STATES(),engine.sun,error))return finish(false);
  if(needMoon&&!engine.series(request.MOON_STATES(),engine.moon,error))return finish(false);
  std::vector<ConstraintObserver> observers;
  const auto selector=flatbufferString(request.TARGET_STATION_ID());bool selected=selector.empty();
  if(request.GROUND_STATIONS())for(const auto* station: *request.GROUND_STATIONS()){
    ConstraintObserver o;o.ground=true;
    if(!parseAcwGroundStation(station,&o.station,&error))return finish(false);
    o.station_id=flatbufferString(station->STATION_ID());
    if(!selector.empty()&&selector!=o.station_id)continue;selected=true;o.blackouts=o.station.blackout_windows;observers.push_back(std::move(o));}
  if(!selected){error="ACW TARGET_STATION_ID does not match a ground station.";return finish(false);}
  if(request.OBSERVERS())for(const auto* observer:*request.OBSERVERS()){
    if(!observer){error="ACW observer is missing.";return finish(false);}
    if(needGround){error="Elevation constraints require ground observers.";return finish(false);}
    ConstraintObserver o;o.observer_id=flatbufferString(observer->OBSERVER_ID());
    if(o.observer_id.empty()){error="ACW moving observers require OBSERVER_ID.";return finish(false);}
    if(!engine.series(observer->STATES(),o.states,error))return finish(false);
    if(observer->BLACKOUT_WINDOWS())for(const auto* b:*observer->BLACKOUT_WINDOWS()){
      if(!b||!isFinite(b->START_JULIAN_DATE_TT())||!isFinite(b->END_JULIAN_DATE_TT())||b->END_JULIAN_DATE_TT()<=b->START_JULIAN_DATE_TT()){error="Invalid observer blackout interval.";return finish(false);}
      o.blackouts.push_back({b->START_JULIAN_DATE_TT(),b->END_JULIAN_DATE_TT()});}
    observers.push_back(std::move(o));}
  if(observers.empty()){error="ACW requires a ground station or moving observer.";return finish(false);}
  for(auto& observer:observers){for(auto& b:observer.blackouts){b.start_julian_date=(b.start_julian_date-engine.epoch)*86400;b.end_julian_date=(b.end_julian_date-engine.epoch)*86400;}
    if(!engine.windows(observer,mode==acwEvaluationMode_CONTINUOUS,windows,error))return finish(false);}
  return finish(true);
}
