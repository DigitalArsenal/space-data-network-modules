// propagator/sgp4-xp: an ephemeris, as the source gives it, to fitted element sets.
//
// Source states go to TEME (frames.hpp), are split into the interval an element set is fitted on and the states after
// it that score it (the held-out stretch), and are fitted by fit.hpp. fitInterval is one such interval: the `fit`
// method of module.cpp calls it on the interval a block declares. fitSource cuts a long ephemeris into windows and
// fits each: the signed OD node of flows/supplemental-omm calls it on every source's arc (engine.hpp).
//
// The engine has no Earth orientation parameters: an Earth-fixed ephemeris is rotated with UT1 = UTC and the mean
// pole (frames.hpp), as the OD fit core does, so a source's SGP4 and SGP4-XP sets are built on the same axes.
#pragma once

#include <algorithm>
#include <cmath>
#include <string>
#include <vector>

#include "engine.hpp"
#include "fit.hpp"
#include "frames.hpp"

namespace sgp4xp {

// Seconds to add to a stamp on `scale` to get UTC, at that stamp's date. false when the leap second table has no entry.
inline bool utcOffsetSeconds(TimeScale scale, const Instant& stamp, double* seconds) {
  if (scale == TimeScale::Utc) { *seconds = 0.0; return true; }
  int64_t y, m, d;
  civilFromDays(stamp.day - kMjdOfUnixEpoch, &y, &m, &d);
  double taiMinusUtc = 0.0;
  if (eraDat(static_cast<int>(y), static_cast<int>(m), static_cast<int>(d), stamp.seconds / kSecondsPerDay, &taiMinusUtc) < 0) return false;
  switch (scale) {
    case TimeScale::Gps: *seconds = 19.0 - taiMinusUtc; return true;
    case TimeScale::Tai: *seconds = -taiMinusUtc; return true;
    case TimeScale::Tt: *seconds = -(taiMinusUtc + 32.184); return true;
    default: return false;
  }
}

bool utcOf(const std::string& iso, TimeScale scale, Instant* out) {
  Instant stamp;
  if (!parseInstant(iso, &stamp)) return false;
  double offset = 0;
  if (!utcOffsetSeconds(scale, stamp, &offset)) return false;
  *out = addSeconds(stamp, offset);
  return true;
}

constexpr double kEarthRotationRadPerS = 7.292115146706979e-5;

// The states in TEME (UTC). Velocities are rotated with the positions' axes (their rate is 1e-11 rad/s, 0.05 mm/s at low
// orbit); an Earth-fixed velocity first gets the Earth's rotation added. `positionOnly` is true when no state has one.
inline bool toTeme(const std::vector<Observed>& in, Frame frame, const EopTable& eop, std::vector<Sample>* out, bool* positionOnly,
                   std::string* code, std::string* why) {
  *positionOnly = true;
  out->clear();
  out->reserve(in.size());
  for (const Observed& s : in) {
    Sample sample;
    sample.t = s.t;
    if (!positionToTeme(frame, s.t, eop, s.r, sample.r)) {
      *code = "frame-failed";
      *why = "No axes at " + formatInstant(s.t, 3) + " (outside ERFA's dates).";
      return false;
    }
    if (s.hasVelocity) {
      double v[3] = {s.v[0], s.v[1], s.v[2]};
      if (frame == Frame::Itrf) {
        v[0] += -kEarthRotationRadPerS * s.r[1];
        v[1] += kEarthRotationRadPerS * s.r[0];
      }
      if (frame != Frame::Teme) {
        const fr::EarthOrientation orientation = eop.at(s.t);
        fr::Epoch epoch;
        if (!frameEpoch(s.t, orientation, &epoch)) { *code = "frame-failed"; *why = "No axes."; return false; }
        fr::Vec3 vec{v[0], v[1], v[2]};
        if (frame == Frame::Itrf) vec = fr::apply(fr::transpose(fr::gcrfToItrf(epoch, orientation)), vec);
        if (frame == Frame::Eme2000) vec = fr::apply(fr::transpose(fr::gcrfToMj2000Eq(epoch)), vec);
        const fr::Vec3 t = fr::apply(fr::gcrfToTeme(epoch), vec);
        v[0] = t.x; v[1] = t.y; v[2] = t.z;
      }
      sample.v[0] = v[0]; sample.v[1] = v[1]; sample.v[2] = v[2];
      sample.hasVelocity = true;
      *positionOnly = false;
    }
    out->push_back(sample);
  }
  return true;
}

// The states of [intervalStart, intervalStop] are fitted; those after intervalStop up to holdStop score the fit.
inline bool fitInterval(const std::vector<Sample>& samples, const Instant& intervalStart, const Instant& intervalStop,
                        const Instant& holdStop, uint32_t norad, size_t maxFitStates, IntervalFit* out, std::string* code,
                        std::string* why) {
  std::vector<Sample> fitSamples, held;
  for (const Sample& s : samples) {
    if (secondsBetween(s.t, intervalStart) < -1e-6) continue;
    if (secondsBetween(s.t, intervalStop) <= 1e-6) fitSamples.push_back(s);
    else if (secondsBetween(s.t, holdStop) <= 1e-6) held.push_back(s);
  }
  if (fitSamples.size() < 10) {
    *code = "too-few-states";
    *why = "the fit interval holds fewer than 10 states.";
    return false;
  }
  const Instant fitStart = fitSamples.front().t, fitStop = fitSamples.back().t;
  const Instant last = held.empty() ? fitStop : held.back().t;
  // No leap second inside the arc: minutes since epoch are counted in 86400-second days.
  {
    int64_t y0, m0, d0, y1, m1, d1;
    civilFromDays(fitStart.day - kMjdOfUnixEpoch, &y0, &m0, &d0);
    civilFromDays(last.day - kMjdOfUnixEpoch, &y1, &m1, &d1);
    double dat0 = 0, dat1 = 0;
    if (eraDat(static_cast<int>(y0), static_cast<int>(m0), static_cast<int>(d0), 0.0, &dat0) < 0 ||
        eraDat(static_cast<int>(y1), static_cast<int>(m1), static_cast<int>(d1), 0.0, &dat1) < 0 || dat0 != dat1) {
      *code = "leap-second-in-arc";
      *why = "a leap second falls inside the arc.";
      return false;
    }
  }
  Fitter fitter(true, maxFitStates);
  FitResult result = fitter.run(fitSamples, held, norad);
  if (!result.ok) {
    *code = result.code;
    *why = result.message;
    return false;
  }
  out->result = std::move(result);
  out->fitStart = fitStart;
  out->fitStop = fitStop;
  out->heldStop = last;
  out->haveHeld = !held.empty();
  return true;
}

bool fitSource(const std::vector<Observed>& states, Frame frame, uint32_t norad, const WindowPolicy& policy, SourceFit* out,
               std::string* code, std::string* why) {
  out->windows.clear();
  out->refusals.clear();
  if (states.size() < 10) {
    *code = "too-few-states";
    *why = "the ephemeris holds fewer than 10 states.";
    return false;
  }
  const EopTable none;
  std::vector<Sample> samples;
  bool positionOnly = true;
  if (!toTeme(states, frame, none, &samples, &positionOnly, code, why)) return false;
  for (size_t i = 1; i < samples.size(); ++i) {
    if (!(secondsBetween(samples[i].t, samples[i - 1].t) > 0)) {
      *code = "epochs-not-increasing";
      *why = "the states' epochs must strictly increase.";
      return false;
    }
  }
  const Instant first = samples.front().t, last = samples.back().t;
  const double arc = secondsBetween(last, first);
  const double fitLength = std::min(policy.fitSeconds, arc * (2.0 / 3.0));
  if (!(fitLength >= 600.0) || !(arc - fitLength >= policy.minHoldSeconds)) {
    *code = "arc-too-short";
    *why = "the ephemeris is shorter than the interval to fit plus the held-out stretch that scores it.";
    return false;
  }
  for (size_t k = 0; k < policy.maxWindows; ++k) {
    const Instant start = addSeconds(first, static_cast<double>(k) * fitLength);
    const Instant stop = addSeconds(start, fitLength);
    if (secondsBetween(last, stop) < policy.minHoldSeconds) break;
    const Instant holdStop = addSeconds(stop, std::min(policy.holdSeconds, secondsBetween(last, stop)));
    IntervalFit fit;
    std::string windowCode, windowWhy;
    if (fitInterval(samples, start, stop, holdStop, norad, policy.maxFitStates, &fit, &windowCode, &windowWhy)) {
      out->windows.push_back(std::move(fit));
    } else {
      out->refusals.push_back("window " + std::to_string(k + 1) + ": " + windowCode + ": " + windowWhy);
    }
  }
  return true;
}

}  // namespace sgp4xp
