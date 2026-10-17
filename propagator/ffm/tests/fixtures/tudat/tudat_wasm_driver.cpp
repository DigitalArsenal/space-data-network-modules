// The tudat_reference.py propagation, in C++, for Tudat compiled to
// WebAssembly by repos/ancillary-packages/tudat-wasm (tudat-wasm-reference.mjs
// builds and runs it). Same bodies, frames, constants, integrator and
// sampling as tudat_reference.py, line for line; only the language differs,
// so a difference between the two reference files is a difference between
// Tudat built natively (tudatpy) and Tudat built for WebAssembly.
//
// stdin:  "K gm fieldRadius shadowRadius mass area cr cd au gmSun gmMoon sunRadius irradiance"
//         "COEF count" + count lines "n m C S" (normalized)
//         "KERNEL path" (repeated; the .bsp is read with CALCEPH)
//         per case: "CASE name degree order thirdBodies srp drag samples"
//                   "x y z vx vy vz" (m, m/s, GCRS)
//                   samples lines "t utcSecondsSinceJ2000"
// stdout: per case "CASE name", then samples lines "t x y z vx vy vz".
#include <cstdio>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

#include "tudat/simulation/simulation.h"
#include "tudat/astro/earth_orientation/terrestrialTimeScaleConverter.h"
#include "tudat/math/interpolators/createInterpolator.h"
#include "tudat/astro/ephemerides/calcephEphemeris.h"

using namespace tudat;
using namespace tudat::simulation_setup;
using namespace tudat::propagators;
using namespace tudat::numerical_integrators;

static int run( );

int main( )
{
    try { return run( ); }
    catch( const std::exception& e ) { std::fprintf( stderr, "tudat_wasm_driver: %s\n", e.what( ) ); return 1; }
}

static int run( )
{
    double gm, fieldRadius, shadowRadius, mass, area, cr, cd, au, gmSun, gmMoon, sunRadius, irradiance;
    std::string tag;
    std::cin >> tag >> gm >> fieldRadius >> shadowRadius >> mass >> area >> cr >> cd >> au >> gmSun >> gmMoon >> sunRadius >> irradiance;
    int count;
    std::cin >> tag >> count;
    Eigen::MatrixXd C = Eigen::MatrixXd::Zero( 21, 21 ), S = Eigen::MatrixXd::Zero( 21, 21 );
    C( 0, 0 ) = 1.0;
    for( int i = 0; i < count; ++i )
    {
        int n, m;
        double c, s;
        std::cin >> n >> m >> c >> s;
        if( n <= 20 ) { C( n, m ) = c; S( n, m ) = s; }
    }
    auto converter = earth_orientation::createDefaultTimeConverter( );
    // Tudat's clock is given TT (tudat_reference.py, TIME_ARGUMENT TT).
    auto clockToTdb = [ & ]( double t ) { return converter->getCurrentTime( basic_astrodynamics::tt_scale, basic_astrodynamics::tdb_scale, t ); };
    auto utcToClock = [ & ]( double t ) { return converter->getCurrentTime( basic_astrodynamics::utc_scale, basic_astrodynamics::tt_scale, t ); };
    const double step = 10.0, stepSrp = 1.0;
    const int oversample = 8;

    std::string spk;
    const std::map< std::string, int > naif{ { "SSB", 0 }, { "Sun", 10 }, { "Moon", 301 }, { "Earth", 399 } };
    while( std::cin >> tag )
    {
        if( tag == "KERNEL" )
        {
            // Binary SPK through CALCEPH (Tudat WASM's SPICE reads text
            // kernels only); text kernels through SPICE.
            std::string path;
            std::cin >> path;
            if( path.size( ) > 4 && path.substr( path.size( ) - 4 ) == ".bsp" ) spk = path;
            else spice_interface::loadSpiceKernelInTudat( path );
            continue;
        }
        std::string name, orbit;
        int degree, order, thirdBodies, srp, drag, samples;
        std::cin >> orbit >> name >> degree >> order >> thirdBodies >> srp >> drag >> samples;
        Eigen::VectorXd x0( 6 );
        for( int i = 0; i < 6; ++i ) std::cin >> x0( i );
        std::vector< std::pair< double, double > > epochs( samples );
        for( auto& e: epochs ) std::cin >> e.first >> e.second;
        const double t0 = utcToClock( epochs.front( ).second ), tEnd = utcToClock( epochs.back( ).second );

        BodyListSettings settings( "Earth", "GCRS" );
        for( const std::string body: { "Earth", "Sun", "Moon", "Sat" } ) settings.addSettings( body );
        auto table = [ & ]( const std::string& target, const std::string& observer ) {
            ephemerides::CalcephEphemeris ephemeris( spk, naif.at( target ), naif.at( observer ), observer, "J2000" );
            std::map< double, Eigen::Vector6d > states;
            for( double t = t0 - 7200.0; t <= tEnd + 7200.0 + 1e-6; t += 60.0 )
                states[ t ] = ephemeris.getCartesianState( clockToTdb( t ) );
            return states;
        };
        auto earth = settings.at( "Earth" );
        earth->ephemerisSettings = std::make_shared< TabulatedEphemerisSettings >( table( "Earth", "SSB" ), "SSB", "GCRS" );
        earth->rotationModelSettings = gcrsToItrsRotationModelSettings( basic_astrodynamics::iau_2006, "GCRS" );
        earth->gravityFieldSettings = degree > 0
                ? std::static_pointer_cast< GravityFieldSettings >( std::make_shared< SphericalHarmonicsGravityFieldSettings >(
                          gm, fieldRadius, C.block( 0, 0, degree + 1, degree + 1 ), S.block( 0, 0, degree + 1, degree + 1 ), "ITRS" ) )
                : centralGravitySettings( gm );
        earth->shapeModelSettings = drag ? oblateSphericalBodyShapeSettings( 6378137.0, 1.0 / 298.257223563 ) : sphericalBodyShapeSettings( shadowRadius );
        // tudatpy's defaults (daily Ap, anomalous oxygen); the C++ default
        // would use the storm-time 3-hourly Ap history instead.
        if( drag ) earth->atmosphereSettings = nrlmsise00AtmosphereSettings( paths::getSpaceWeatherDataPath( ) + "/sw19571001.txt", false, true );
        for( const std::string body: { "Sun", "Moon" } )
            settings.at( body )->ephemerisSettings = std::make_shared< TabulatedEphemerisSettings >( table( body, "Earth" ), "Earth", "GCRS" );
        settings.at( "Sun" )->gravityFieldSettings = centralGravitySettings( gmSun );
        settings.at( "Moon" )->gravityFieldSettings = centralGravitySettings( gmMoon );
        settings.at( "Sun" )->shapeModelSettings = sphericalBodyShapeSettings( sunRadius );
        settings.at( "Sun" )->radiationSourceModelSettings =
                isotropicPointRadiationSourceModelSettings( irradianceBasedLuminosityModelSettings( irradiance, au ) );
        settings.at( "Sat" )->constantMass = mass;
        if( srp )
            settings.at( "Sat" )->radiationPressureTargetModelSettings =
                    cannonballRadiationPressureTargetModelSettingsWithOccultationMap( area, cr, { { "Sun", { "Earth" } } } );
        if( drag )
            settings.at( "Sat" )->aerodynamicCoefficientSettings = constantAerodynamicCoefficientSettings( area, Eigen::Vector3d( cd, 0.0, 0.0 ) );
        SystemOfBodies bodies = createSystemOfBodies( settings );

        SelectedAccelerationMap selected;
        auto& onSat = selected[ "Sat" ];
        onSat[ "Earth" ].push_back( degree > 0 ? sphericalHarmonicAcceleration( degree, order ) : pointMassGravityAcceleration( ) );
        if( drag ) onSat[ "Earth" ].push_back( aerodynamicAcceleration( ) );
        if( thirdBodies )
        {
            onSat[ "Sun" ].push_back( pointMassGravityAcceleration( ) );
            onSat[ "Moon" ].push_back( pointMassGravityAcceleration( ) );
        }
        if( srp ) onSat[ "Sun" ].push_back( radiationPressureAcceleration( ) );
        auto models = createAccelerationModelsMap( bodies, selected, std::vector< std::string >{ "Sat" }, std::vector< std::string >{ "Earth" } );
        const double h = srp ? stepSrp : step;
        auto propagatorSettings = translationalStatePropagatorSettings< double, double >(
                { "Earth" }, models, { "Sat" }, x0, t0, rungeKuttaFixedStepSettings< double >( h, rungeKutta87DormandPrince ),
                propagationTimeTerminationSettings( tEnd + oversample * h, true ), cowell );
        propagatorSettings->getOutputSettings( )->getPrintSettings( )->disableAllPrinting( );
        SingleArcDynamicsSimulator< double, double > simulator( bodies, propagatorSettings );
        const std::map< double, Eigen::VectorXd > history = simulator.getEquationsOfMotionNumericalSolution( );
        auto interpolator = interpolators::createOneDimensionalInterpolator< double, Eigen::VectorXd >(
                history, std::make_shared< interpolators::LagrangeInterpolatorSettings >( oversample ) );

        std::printf( "CASE %s %s\n", orbit.c_str( ), name.c_str( ) );
        for( const auto& e: epochs )
        {
            const Eigen::VectorXd x = e.first > 0 ? interpolator->interpolate( utcToClock( e.second ) ) : x0;
            std::printf( "%.1f %.17g %.17g %.17g %.17g %.17g %.17g\n", e.first, x( 0 ), x( 1 ), x( 2 ), x( 3 ), x( 4 ), x( 5 ) );
        }
        std::fflush( stdout );
    }
    return 0;
}
