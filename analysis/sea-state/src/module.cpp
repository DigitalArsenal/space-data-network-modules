#include "space_data_module_invoke.h"
#include "sea_state.hpp"
#include "wire.hpp"

extern "C" int sea_state() {
  using namespace sea;
  wire::Request q;
  if (!q.only({"wind_speed_10m_mps","fetch_m","duration_s","wind_from_deg",
      "wave_height_m","wave_period_s","wave_from_deg"}))
    return wire::fail("invalid-input","Expected one PCE request with documented sea-state scalar fields only.");
  for (const auto& entry : q.values)
    if (!std::isfinite(q.number(entry.first.c_str())))
      return wire::fail("invalid-input","Every supplied parameter must be a finite real scalar.");
  Input in{q.number("wind_speed_10m_mps"),q.number("fetch_m",0),q.number("duration_s",0),
    q.number("wind_from_deg",0),q.number("wave_height_m",0),q.number("wave_period_s",0),q.number("wave_from_deg")};
  const auto scale_ok = [](double v) {return v == 0 || (v >= 1e-6 && v <= 1e12);};
  if (!std::isfinite(in.wind) || (in.wind>0 && in.wind<1e-6) || !scale_ok(in.fetch) || !scale_ok(in.duration))
    return wire::fail("invalid-input","Wind required (positive minimum 1e-6 m/s); fetch/duration zero means unlimited, otherwise 1e-6..1e12 SI units.");
  const auto s = evaluate(in);
  wire::Result r;
  r.number("hs_m",s.hs,"m"); r.number("tp_s",s.tp,"s"); r.number("fp_hz",s.fp,"Hz");
  r.number("m0_m2",s.m0,"m2"); r.number("alpha",s.alpha); r.number("gamma",s.gamma);
  r.number("sigma_a",.07); r.number("sigma_b",.09);
  r.number("wind_speed_19_5m_mps",s.wind19,"m/s");
  r.number("effective_fetch_m",s.effective_fetch,"m"); r.number("dimensionless_fetch",s.dimensionless_fetch);
  r.text("regime",s.regime);
  r.number("windSpeedMps",s.wind,"m/s"); r.number("windFromDeg",s.wind_from,"deg");
  r.number("swellHeightM",s.swell_height,"m"); r.number("swellPeriodS",s.swell_period,"s");
  r.number("swellFromDeg",s.swell_from,"deg"); r.number("chop",s.chop);
  r.text("model","jonswap1973-pm1964-spm-height-v1");
  return r.emit();
}
