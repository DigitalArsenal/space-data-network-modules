// Coefficient baking and evaluation share the same bracket keys.

[[gnu::noinline]] inline void mdaily_sync_cache(MdailyEvalCache& mc, const float* F, int degree, double a_state, double e2_state,
                                                double t, uint64_t table_id = 0) {
  double a_full, e2_full, a_part;
  int64_t kfa, kfe = 0, kpa;
  const bool anchored = sp_anchored(t);
  if (anchored) {
    double e_f, c_f, e_p, c_p;
    kfa = sp_anchor_point(g_sp_anchor, t, 3e-5, 2e-6, true, 0.0, a_full, e_f, c_f);
    e2_full = e_f * e_f;
    kpa = sp_anchor_point(g_sp_anchor, t, 2e-6, 1e30, false, 0.0, a_part, e_p, c_p);
  } else {
    kfa = sp_cell_rel(a_state, 3e-5, a_full);
    kfe = sp_cell_abs(e2_state, 2e-6, e2_full);
    kpa = sp_cell_rel(a_state, 2e-6, a_part);
  }
  const uint64_t aid = anchored ? g_sp_anchor.id : 0;
  const bool full = table_id == 0 || mc.table_id != table_id || mc.F != F || mc.degree != degree || mc.f0 != F[0] ||
                    mc.f1 != F[1] || !mc.keys_valid || mc.anchor_id != aid || kfa != mc.kf_a || kfe != mc.kf_e;
  // what md_keys_hold compares with: the keys below are the cache's when this call returns (kept, or baked now)
  mc.on_bracket = anchored;
  if (anchored) {
    mc.kb_tlo = g_sp_anchor.tlo;
    mc.kb_h = g_sp_anchor.h;
    mc.n_full = static_cast<int32_t>(kfa >> 6);
    mc.n_part = static_cast<int32_t>(kpa >> 6);
  }
  if (!full && kpa == mc.kp_a) return;
  const double a = full ? a_full : a_part, e2 = e2_full;
  auto sync_f32 = [&]() {
    if (degree <= 20) {
      const int n_quad = (degree + 3) & ~3;
      for (int m = 1; m <= degree; ++m) {
        const int idx = m - 1;
        mc.c10_f[idx] = static_cast<float>(mc.c_pair1[m][0]);
        mc.s10_f[idx] = static_cast<float>(mc.s_pair1[m][0]);
        mc.c11_f[idx] = static_cast<float>(mc.c_pair1[m][1]);
        mc.s11_f[idx] = static_cast<float>(mc.s_pair1[m][1]);
        mc.c20_f[idx] = static_cast<float>(mc.c_pair2[m][0]);
        mc.s20_f[idx] = static_cast<float>(mc.s_pair2[m][0]);
        mc.c21_f[idx] = static_cast<float>(mc.c_pair2[m][1]);
        mc.s21_f[idx] = static_cast<float>(mc.s_pair2[m][1]);
      }
      for (int idx = degree; idx < n_quad; ++idx) {
        mc.c10_f[idx] = mc.s10_f[idx] = 0.0f;
        mc.c11_f[idx] = mc.s11_f[idx] = 0.0f;
        mc.c20_f[idx] = mc.s20_f[idx] = 0.0f;
        mc.c21_f[idx] = mc.s21_f[idx] = 0.0f;
      }
    }
  };
  if (full) {
    mc.F = F;
    mc.table_id = table_id;
    mc.keys_valid = true;
    mc.anchor_id = aid;
    mc.kf_a = kfa;
    mc.kf_e = kfe;
    mc.kp_a = INT64_MIN;
    mc.degree = degree;
    mc.f0 = F[0];
    mc.f1 = F[1];
    mc.a = a;
    mc.a_bake = a;
    mc.e2 = e2;
    for (int m = 1; m <= degree; ++m) {
      mc.c0_pair1[m][0] = mc.c0_pair1[m][1] = 0.0;
      mc.s0_pair1[m][0] = mc.s0_pair1[m][1] = 0.0;
      mc.c0_pair2[m][0] = mc.c0_pair2[m][1] = 0.0;
      mc.s0_pair2[m][0] = mc.s0_pair2[m][1] = 0.0;
      mc.dc_pair1[m][0] = mc.dc_pair1[m][1] = 0.0;
      mc.ds_pair1[m][0] = mc.ds_pair1[m][1] = 0.0;
      mc.dc_pair2[m][0] = mc.dc_pair2[m][1] = 0.0;
      mc.ds_pair2[m][0] = mc.ds_pair2[m][1] = 0.0;
    }
    const double g2 = 1.0 / (1.0 - e2);
    const double ia = 1.0 / a;
    double A = kMu * ia * ia * ia;
    double W = g2 * std::sqrt(g2);
    const double e2_4 = 0.25 * e2;
    int j = 0;
    for (int l = 2; l <= degree; l += 2) {
      double Q = 1.0, dQ_oe = 0.0, term = 1.0;
      for (int s2 = 2, k_idx = 1; s2 <= l - 1; s2 += 2, ++k_idx) {
        const double step_f = static_cast<double>((l - s2 + 1) * (l - s2)) * kInvM[k_idx] * kInvM[k_idx];
        dQ_oe += (term * step_f) * (0.25 * s2);
        term *= step_f * e2_4;
        Q += term;
      }
      const double G = W * Q;
      const double dG_oe = W * ((2.0 * l - 1.0) * g2 * Q + dQ_oe);
      const double AG = A * G, AdG_oe = A * dG_oe;
      const double lp1 = static_cast<double>(l + 1);
      for (int m = 1; m <= l; ++m, ++j) {
        const double C = kEgmC[l][m], S = kEgmS[l][m];
        const double Fv = F[2 * j], dF = F[2 * j + 1];
        const bool odd = ((l - m) & 1) != 0;
        const double inv_m = kInvM[m];
        const double sc_psi = odd ? -S : C, ss_psi = odd ? C : S;
        const double sc_1 = (odd ? -C : -S) * inv_m, ss_1 = (odd ? -S : C) * inv_m;
        const double AFG = AG * Fv, AdFG = AG * dF, AFdG_oe = AdG_oe * Fv;
        const double t_c10 = AFG * sc_psi, t_s10 = AFG * ss_psi;
        const double t_c11 = (lp1 * AFG) * sc_1, t_s11 = (lp1 * AFG) * ss_1;
        const double t_c20 = AdFG * sc_1, t_s20 = AdFG * ss_1;
        const double t_c21 = AFdG_oe * sc_1, t_s21 = AFdG_oe * ss_1;
        mc.c0_pair1[m][0] += t_c10;
        mc.s0_pair1[m][0] += t_s10;
        mc.c0_pair1[m][1] += t_c11;
        mc.s0_pair1[m][1] += t_s11;
        mc.c0_pair2[m][0] += t_c20;
        mc.s0_pair2[m][0] += t_s20;
        mc.c0_pair2[m][1] += t_c21;
        mc.s0_pair2[m][1] += t_s21;
        mc.dc_pair1[m][0] += lp1 * t_c10;
        mc.ds_pair1[m][0] += lp1 * t_s10;
        mc.dc_pair1[m][1] += lp1 * t_c11;
        mc.ds_pair1[m][1] += lp1 * t_s11;
        mc.dc_pair2[m][0] += lp1 * t_c20;
        mc.ds_pair2[m][0] += lp1 * t_s20;
        mc.dc_pair2[m][1] += lp1 * t_c21;
        mc.ds_pair2[m][1] += lp1 * t_s21;
      }
      A *= ia * ia;
      W *= g2 * g2;
    }
    for (int m = 1; m <= degree; ++m) {
      mc.c_pair1[m][0] = mc.c0_pair1[m][0];
      mc.c_pair1[m][1] = mc.c0_pair1[m][1];
      mc.s_pair1[m][0] = mc.s0_pair1[m][0];
      mc.s_pair1[m][1] = mc.s0_pair1[m][1];
      mc.c_pair2[m][0] = mc.c0_pair2[m][0];
      mc.c_pair2[m][1] = mc.c0_pair2[m][1];
      mc.s_pair2[m][0] = mc.s0_pair2[m][0];
      mc.s_pair2[m][1] = mc.s0_pair2[m][1];
    }
    sync_f32();
  }
  if (kpa != mc.kp_a) {
    mc.kp_a = kpa;
    mc.a_bake = a_part;
    const double u_a = mc.a / a_part - 1.0;
#ifdef __wasm_simd128__
    const v128_t vu = wasm_f64x2_splat(u_a);
    for (int m = 1; m <= degree; ++m) {
      wasm_v128_store(mc.c_pair1[m], wasm_f64x2_add(wasm_v128_load(mc.c0_pair1[m]), wasm_f64x2_mul(wasm_v128_load(mc.dc_pair1[m]), vu)));
      wasm_v128_store(mc.s_pair1[m], wasm_f64x2_add(wasm_v128_load(mc.s0_pair1[m]), wasm_f64x2_mul(wasm_v128_load(mc.ds_pair1[m]), vu)));
      wasm_v128_store(mc.c_pair2[m], wasm_f64x2_add(wasm_v128_load(mc.c0_pair2[m]), wasm_f64x2_mul(wasm_v128_load(mc.dc_pair2[m]), vu)));
      wasm_v128_store(mc.s_pair2[m], wasm_f64x2_add(wasm_v128_load(mc.s0_pair2[m]), wasm_f64x2_mul(wasm_v128_load(mc.ds_pair2[m]), vu)));
    }
#else
    for (int m = 1; m <= degree; ++m) {
      mc.c_pair1[m][0] = mc.c0_pair1[m][0] + mc.dc_pair1[m][0] * u_a;
      mc.c_pair1[m][1] = mc.c0_pair1[m][1] + mc.dc_pair1[m][1] * u_a;
      mc.s_pair1[m][0] = mc.s0_pair1[m][0] + mc.ds_pair1[m][0] * u_a;
      mc.s_pair1[m][1] = mc.s0_pair1[m][1] + mc.ds_pair1[m][1] * u_a;
      mc.c_pair2[m][0] = mc.c0_pair2[m][0] + mc.dc_pair2[m][0] * u_a;
      mc.c_pair2[m][1] = mc.c0_pair2[m][1] + mc.dc_pair2[m][1] * u_a;
      mc.s_pair2[m][0] = mc.s0_pair2[m][0] + mc.ds_pair2[m][0] * u_a;
      mc.s_pair2[m][1] = mc.s0_pair2[m][1] + mc.ds_pair2[m][1] * u_a;
    }
#endif
    sync_f32();
  }
}

[[gnu::always_inline]] inline bool md_keys_hold(const MdailyEvalCache& mc, const float* F, int degree, double t, uint64_t table_id) {
  const SpAnchor& an = g_sp_anchor;
  if (!mc.on_bracket || !mc.keys_valid || table_id == 0 || mc.table_id != table_id || mc.F != F || mc.degree != degree ||
      mc.f0 != F[0] || mc.f1 != F[1] || !an.valid || an.h == 0.0 || an.id != mc.anchor_id || an.tlo != mc.kb_tlo ||
      an.h != mc.kb_h)
    return false;
  const double q = (t - an.tlo) / an.h;
  if (!(q >= 0.0 && q <= 1.0)) return false;
  return sp_part_key(q, mc.n_full) == mc.kf_a && mc.kf_e == 0 && sp_part_key(q, mc.n_part) == mc.kp_a;
}

[[gnu::always_inline]] inline void mdaily_six(
    const float* F, int degree, double t, const Kepler& k, double n, double eta, double si,
    double ci, double theta_g0, double* six, double* sb_out = nullptr, double* cb_out = nullptr,
    float* cm_f32_out = nullptr, float* sm_f32_out = nullptr, int* cm_count_out = nullptr,
    double* cm_last_out = nullptr, double* sm_last_out = nullptr,
    const double* sb_in = nullptr, const double* cb_in = nullptr, uint64_t table_id = 0) {
  const double a = k.a, e = k.e, e2 = e * e;
  MdailyEvalCache& mc = mdaily_eval_cache();
  if (!md_keys_hold(mc, F, degree, t, table_id)) mdaily_sync_cache(mc, F, degree, a, e2, t, table_id);
  double sb, cb;
  if (sb_in != nullptr && cb_in != nullptr) {
    sb = *sb_in;
    cb = *cb_in;
  } else {
    fm::sincos_fast(k.node - (theta_g0 + kOmegaE * t), sb, cb);
  }
  if (sb_out != nullptr) {
    *sb_out = sb;
    *cb_out = cb;
  }
  double cm = 1.0, sm = 0.0;
  double s_afg_psi = 0.0, s_afg_l1 = 0.0, s_adfg = 0.0, s_afdg_oe = 0.0;
#ifdef __wasm_simd128__
  if (t != 0.0 && degree >= 2 && degree <= 20) {
    const int n_quad = (degree + 3) & ~3;
    const double c1 = cb, s1 = sb;
    const double c2 = c1 * cb - s1 * sb, s2 = s1 * cb + c1 * sb;
    const double c3 = c2 * cb - s2 * sb, s3 = s2 * cb + c2 * sb;
    const double c4 = c3 * cb - s3 * sb, s4 = s3 * cb + c3 * sb;
    v128_t v_cm = wasm_f32x4_make(static_cast<float>(c1), static_cast<float>(c2), static_cast<float>(c3), static_cast<float>(c4));
    v128_t v_sm = wasm_f32x4_make(static_cast<float>(s1), static_cast<float>(s2), static_cast<float>(s3), static_cast<float>(s4));
    const v128_t v_c4 = wasm_f32x4_splat(static_cast<float>(c4));
    const v128_t v_s4 = wasm_f32x4_splat(static_cast<float>(s4));
    v128_t a10 = wasm_f32x4_splat(0.0f), a11 = wasm_f32x4_splat(0.0f);
    v128_t a20 = wasm_f32x4_splat(0.0f), a21 = wasm_f32x4_splat(0.0f);
    for (int idx = 0;;) {
      if (cm_f32_out != nullptr) {
        wasm_v128_store(cm_f32_out + idx, v_cm);
        wasm_v128_store(sm_f32_out + idx, v_sm);
      }
      a10 = wasm_f32x4_add(a10, wasm_f32x4_add(wasm_f32x4_mul(wasm_v128_load(mc.c10_f + idx), v_cm),
                                               wasm_f32x4_mul(wasm_v128_load(mc.s10_f + idx), v_sm)));
      a11 = wasm_f32x4_add(a11, wasm_f32x4_add(wasm_f32x4_mul(wasm_v128_load(mc.c11_f + idx), v_cm),
                                               wasm_f32x4_mul(wasm_v128_load(mc.s11_f + idx), v_sm)));
      a20 = wasm_f32x4_add(a20, wasm_f32x4_add(wasm_f32x4_mul(wasm_v128_load(mc.c20_f + idx), v_cm),
                                               wasm_f32x4_mul(wasm_v128_load(mc.s20_f + idx), v_sm)));
      a21 = wasm_f32x4_add(a21, wasm_f32x4_add(wasm_f32x4_mul(wasm_v128_load(mc.c21_f + idx), v_cm),
                                               wasm_f32x4_mul(wasm_v128_load(mc.s21_f + idx), v_sm)));
      idx += 4;
      if (idx >= n_quad) break;
      const v128_t ncm = wasm_f32x4_sub(wasm_f32x4_mul(v_cm, v_c4), wasm_f32x4_mul(v_sm, v_s4));
      v_sm = wasm_f32x4_add(wasm_f32x4_mul(v_sm, v_c4), wasm_f32x4_mul(v_cm, v_s4));
      v_cm = ncm;
    }
    if (cm_f32_out != nullptr) {
      *cm_count_out = n_quad;
      *cm_last_out = wasm_f32x4_extract_lane(v_cm, 3);
      *sm_last_out = wasm_f32x4_extract_lane(v_sm, 3);
    }
    const v128_t s10_11 = wasm_f32x4_add(wasm_i32x4_shuffle(a10, a11, 0, 1, 4, 5),
                                         wasm_i32x4_shuffle(a10, a11, 2, 3, 6, 7));
    const v128_t s20_21 = wasm_f32x4_add(wasm_i32x4_shuffle(a20, a21, 0, 1, 4, 5),
                                         wasm_i32x4_shuffle(a20, a21, 2, 3, 6, 7));
    const v128_t sums = wasm_f32x4_add(wasm_i32x4_shuffle(s10_11, s20_21, 0, 2, 4, 6),
                                       wasm_i32x4_shuffle(s10_11, s20_21, 1, 3, 5, 7));
    s_afg_psi = wasm_f32x4_extract_lane(sums, 0);
    s_afg_l1 = wasm_f32x4_extract_lane(sums, 1);
    s_adfg = wasm_f32x4_extract_lane(sums, 2);
    s_afdg_oe = wasm_f32x4_extract_lane(sums, 3);
  } else {
    v128_t acc1 = wasm_f64x2_splat(0.0);
    v128_t acc2 = wasm_f64x2_splat(0.0);
    for (int m = 1; m <= degree; ++m) {
      const double ncm = cm * cb - sm * sb;
      sm = sm * cb + cm * sb;
      cm = ncm;
      if (cm_f32_out != nullptr) {
        cm_f32_out[m - 1] = static_cast<float>(cm);
        sm_f32_out[m - 1] = static_cast<float>(sm);
      }
      const v128_t v_cm = wasm_f64x2_splat(cm);
      const v128_t v_sm = wasm_f64x2_splat(sm);
      acc1 = wasm_f64x2_add(acc1, wasm_f64x2_add(wasm_f64x2_mul(wasm_v128_load(mc.c_pair1[m]), v_cm),
                                                 wasm_f64x2_mul(wasm_v128_load(mc.s_pair1[m]), v_sm)));
      acc2 = wasm_f64x2_add(acc2, wasm_f64x2_add(wasm_f64x2_mul(wasm_v128_load(mc.c_pair2[m]), v_cm),
                                                 wasm_f64x2_mul(wasm_v128_load(mc.s_pair2[m]), v_sm)));
    }
    if (cm_f32_out != nullptr) {
      *cm_count_out = degree;
      *cm_last_out = cm;
      *sm_last_out = sm;
    }
    s_afg_psi = wasm_f64x2_extract_lane(acc1, 0);
    s_afg_l1 = wasm_f64x2_extract_lane(acc1, 1);
    s_adfg = wasm_f64x2_extract_lane(acc2, 0);
    s_afdg_oe = wasm_f64x2_extract_lane(acc2, 1);
  }
#else
  for (int m = 1; m <= degree; ++m) {
    const double ncm = cm * cb - sm * sb;
    sm = sm * cb + cm * sb;
    cm = ncm;
    if (cm_f32_out != nullptr) {
      cm_f32_out[m - 1] = static_cast<float>(cm);
      sm_f32_out[m - 1] = static_cast<float>(sm);
    }
    s_afg_psi += mc.c_pair1[m][0] * cm + mc.s_pair1[m][0] * sm;
    s_afg_l1 += mc.c_pair1[m][1] * cm + mc.s_pair1[m][1] * sm;
    s_adfg += mc.c_pair2[m][0] * cm + mc.s_pair2[m][0] * sm;
    s_afdg_oe += mc.c_pair2[m][1] * cm + mc.s_pair2[m][1] * sm;
  }
  if (cm_f32_out != nullptr) {
    *cm_count_out = degree;
    *cm_last_out = cm;
    *sm_last_out = sm;
  }
#endif
  const double sin_i = std::fabs(si) < 1e-12 ? (si < 0.0 ? -1e-12 : 1e-12) : si;
  const double p = a * eta * eta;
  const double na2 = n * a * a;
#ifdef __wasm_simd128__
  const v128_t vd0 = wasm_f64x2_div(wasm_f64x2_splat(1.0), wasm_f64x2_make(p * p, eta));
  const v128_t vd2 = wasm_f64x2_div(wasm_f64x2_splat(1.0), wasm_f64x2_make(sin_i, 1.0 + eta));
  const double node_rate = -1.5 * n * kJ2 * ci * wasm_f64x2_extract_lane(vd0, 0);
  const double inv_eta = wasm_f64x2_extract_lane(vd0, 1);
  const v128_t vd1 = wasm_f64x2_div(wasm_f64x2_splat(1.0), wasm_f64x2_make(na2 * (node_rate - kOmegaE), 1.0 + ci));
  const double inv_na2_bdot = wasm_f64x2_extract_lane(vd1, 0);
  const double tanhalf = sin_i * wasm_f64x2_extract_lane(vd1, 1);
  const double dsO = (inv_na2_bdot * inv_eta) * s_adfg;
  const double th_dsO = tanhalf * dsO;
  six[2] += (-inv_na2_bdot * inv_eta * wasm_f64x2_extract_lane(vd2, 0)) * s_afg_psi;
  six[3] += e * ((eta * inv_na2_bdot) * s_afdg_oe + th_dsO);
  six[4] += dsO;
  six[5] += (2.0 * inv_na2_bdot) * s_afg_l1 + ((eta * e2 * wasm_f64x2_extract_lane(vd2, 1)) * inv_na2_bdot) * s_afdg_oe + th_dsO;
#else
  const double node_rate = -1.5 * n * kJ2 * ci / (p * p);
  const double tanhalf = sin_i / (1.0 + ci);
  const double inv_na2_bdot = 1.0 / (na2 * (node_rate - kOmegaE));
  const double inv_eta = 1.0 / eta;
  const double dsO = (inv_na2_bdot * inv_eta) * s_adfg;
  const double th_dsO = tanhalf * dsO;
  six[2] += (-inv_na2_bdot * inv_eta / sin_i) * s_afg_psi;
  six[3] += e * ((eta * inv_na2_bdot) * s_afdg_oe + th_dsO);
  six[4] += dsO;
  six[5] += (2.0 * inv_na2_bdot) * s_afg_l1 + ((eta * e2 / (1.0 + eta)) * inv_na2_bdot) * s_afdg_oe + th_dsO;
#endif
}

[[gnu::noinline]] inline void sp_rebake_res(SpEvalCache& sc, double a0, double e0, double a, double e,
                                            double n, double eta, double ci, double ia) {
  sc.a_res = a;
  sc.e_res = e;
  sc.ci_res = ci;
  const double p_sl = a * eta * eta, j2 = 1.5 * kJ2 / (p_sl * p_sl);
  const double node_rate = -j2 * n * ci, wdot = 0.5 * j2 * n * (5.0 * ci * ci - 1.0);
  const double mdot = n + 0.5 * j2 * n * eta * (3.0 * ci * ci - 1.0);
  const double beta_dot = node_rate - kOmegaE;
  const double da = a0 * ia - 1.0, de_bake = sc.e_bake - e0;
  const float de_pe_diff_f = static_cast<float>(sc.e_pe_bake - sc.e_bake);
  const double alpha_A = -2.0 * ia / (n * a), beta_L = 3.0 * ia * ia;
#ifdef __wasm_simd128__
  float mdot_hi = 0.0f, mdot_lo = 0.0f, bdot_hi = 0.0f, bdot_lo = 0.0f;
  sp_split16_f32(mdot, mdot_hi, mdot_lo);
  sp_split16_f32(beta_dot, bdot_hi, bdot_lo);
  const v128_t v_one_f = wasm_f32x4_splat(1.0f);
  const v128_t v_wdot_f = wasm_f32x4_splat(static_cast<float>(wdot));
  const v128_t v_mdot_hi = wasm_f32x4_splat(mdot_hi);
  const v128_t v_mdot_lo = wasm_f32x4_splat(mdot_lo);
  const v128_t v_bdot_hi = wasm_f32x4_splat(bdot_hi);
  const v128_t v_bdot_lo = wasm_f32x4_splat(bdot_lo);
  const v128_t v_da = wasm_f32x4_splat(static_cast<float>(da));
  const v128_t v_hda = wasm_f32x4_splat(static_cast<float>(0.5 * da));
  const v128_t v_de_b = wasm_f32x4_splat(static_cast<float>(de_bake));
  const v128_t v_de_pe_diff = wasm_f32x4_splat(de_pe_diff_f);
  const v128_t v_alpha = wasm_f32x4_splat(static_cast<float>(alpha_A));
  const v128_t v_nalpha = wasm_f32x4_splat(static_cast<float>(-alpha_A));
  const v128_t v_beta_L = wasm_f32x4_splat(static_cast<float>(beta_L));
  for (int rk = 0; rk < sc.n_res_blks; ++rk) {
    const int bi = sc.res_blk[rk];
    const int lane_off = bi * 4;
    const v128_t v_active = wasm_v128_load(sc.blk_active + lane_off);
    const v128_t v_mf = wasm_v128_load(sc.blk_mf + lane_off);
    const v128_t v_wf = wasm_v128_load(sc.blk_w + lane_off);
    const v128_t v_jf = wasm_f32x4_add(v_wf, wasm_v128_load(sc.blk_q + lane_off));
    const v128_t v_bj = wasm_f32x4_mul(v_beta_L, v_jf);
    const v128_t v_psidot = wasm_f32x4_add(
        wasm_f32x4_add(wasm_f32x4_mul(v_jf, v_mdot_hi), wasm_f32x4_mul(v_mf, v_bdot_hi)),
        wasm_f32x4_add(wasm_f32x4_add(wasm_f32x4_mul(v_jf, v_mdot_lo), wasm_f32x4_mul(v_mf, v_bdot_lo)),
                       wasm_f32x4_mul(v_wf, v_wdot_f)));
    const v128_t v_ip = wasm_v128_and(wasm_f32x4_div(v_one_f, v_psidot), v_active);
    const float* const pc = sc.blk_c + bi * 64;
    float* const pec = sc.blk_hot + bi * 32;
    float* const pu = pec + 8;
    float* const pe = sc.blk_e + bi * 16;
    const v128_t uc0 = wasm_v128_load(pc + 0), us0 = wasm_v128_load(pc + 4);
    const v128_t dc0 = wasm_v128_load(pc + 8), ds0 = wasm_v128_load(pc + 12);
    const v128_t dca = wasm_v128_load(pc + 16), dsa = wasm_v128_load(pc + 20);
    const v128_t ec0 = wasm_v128_load(pc + 24), es0 = wasm_v128_load(pc + 28);
    const v128_t eca = wasm_v128_load(pc + 32), esa = wasm_v128_load(pc + 36);
    const v128_t ic0 = wasm_v128_load(pc + 40), is0 = wasm_v128_load(pc + 44);
    const v128_t ica = wasm_v128_load(pc + 48), isa = wasm_v128_load(pc + 52);
    const v128_t ice = wasm_v128_load(pc + 56), ise = wasm_v128_load(pc + 60);
    const v128_t ec = wasm_f32x4_add(ec0, wasm_f32x4_mul(eca, v_da));
    const v128_t es = wasm_f32x4_add(es0, wasm_f32x4_mul(esa, v_da));
    const v128_t uc_base = wasm_f32x4_sub(uc0, wasm_f32x4_mul(wasm_f32x4_add(dc0, wasm_f32x4_mul(dca, v_hda)), v_da));
    const v128_t us_base = wasm_f32x4_sub(us0, wasm_f32x4_mul(wasm_f32x4_add(ds0, wasm_f32x4_mul(dsa, v_hda)), v_da));
    const v128_t uc_b = wasm_f32x4_add(uc_base, wasm_f32x4_mul(ec, v_de_b));
    const v128_t us_b = wasm_f32x4_add(us_base, wasm_f32x4_mul(es, v_de_b));
    const v128_t ic_b = wasm_f32x4_add(wasm_f32x4_add(ic0, wasm_f32x4_mul(ica, v_da)), wasm_f32x4_mul(ice, v_de_b));
    const v128_t is_b = wasm_f32x4_add(wasm_f32x4_add(is0, wasm_f32x4_mul(isa, v_da)), wasm_f32x4_mul(ise, v_de_b));
    const v128_t duc_dda = wasm_f32x4_sub(wasm_f32x4_mul(eca, v_de_b), wasm_f32x4_add(dc0, wasm_f32x4_mul(dca, v_da)));
    const v128_t dus_dda = wasm_f32x4_sub(wasm_f32x4_mul(esa, v_de_b), wasm_f32x4_add(ds0, wasm_f32x4_mul(dsa, v_da)));
    const v128_t dc_b = wasm_f32x4_sub(wasm_f32x4_mul(dc0, v_da), duc_dda);
    const v128_t ds_b = wasm_f32x4_sub(wasm_f32x4_mul(ds0, v_da), dus_dda);
    const v128_t ec_ip = wasm_f32x4_mul(ec, v_ip), es_ip = wasm_f32x4_mul(es, v_ip);
    const v128_t uc_b_ip = wasm_f32x4_mul(uc_b, v_ip), us_b_ip = wasm_f32x4_mul(us_b, v_ip);
    v128_t ic_b_ip = wasm_f32x4_mul(ic_b, v_ip), is_b_ip = wasm_f32x4_mul(is_b, v_ip);
    v128_t lc_b_ip = wasm_f32x4_sub(wasm_f32x4_mul(v_alpha, wasm_f32x4_mul(dc_b, v_ip)), wasm_f32x4_mul(v_bj, wasm_f32x4_mul(uc_b_ip, v_ip)));
    v128_t ls_b_ip = wasm_f32x4_sub(wasm_f32x4_mul(v_alpha, wasm_f32x4_mul(ds_b, v_ip)), wasm_f32x4_mul(v_bj, wasm_f32x4_mul(us_b_ip, v_ip)));
    const v128_t pe0 = wasm_f32x4_mul(ice, v_ip);
    const v128_t pe4 = wasm_f32x4_mul(ise, v_ip);
    const v128_t pe8 = wasm_f32x4_mul(wasm_f32x4_sub(wasm_f32x4_mul(v_nalpha, eca), wasm_f32x4_mul(v_bj, ec_ip)), v_ip);
    const v128_t pe12 = wasm_f32x4_mul(wasm_f32x4_sub(wasm_f32x4_mul(v_nalpha, esa), wasm_f32x4_mul(v_bj, es_ip)), v_ip);
    if (sc.blk_is_pe[bi]) {
      ic_b_ip = wasm_f32x4_add(ic_b_ip, wasm_f32x4_mul(pe0, v_de_pe_diff));
      is_b_ip = wasm_f32x4_add(is_b_ip, wasm_f32x4_mul(pe4, v_de_pe_diff));
      lc_b_ip = wasm_f32x4_add(lc_b_ip, wasm_f32x4_mul(pe8, v_de_pe_diff));
      ls_b_ip = wasm_f32x4_add(ls_b_ip, wasm_f32x4_mul(pe12, v_de_pe_diff));
    }
    wasm_v128_store(pec + 0, ec_ip);  wasm_v128_store(pec + 4, es_ip);
    wasm_v128_store(pu + 0, uc_b_ip); wasm_v128_store(pu + 4, us_b_ip);
    wasm_v128_store(pu + 8, ic_b_ip); wasm_v128_store(pu + 12, is_b_ip);
    wasm_v128_store(pu + 16, lc_b_ip); wasm_v128_store(pu + 20, ls_b_ip);
    wasm_v128_store(pe + 0, pe0);
    wasm_v128_store(pe + 4, pe4);
    wasm_v128_store(pe + 8, pe8);
    wasm_v128_store(pe + 12, pe12);
  }
#else
  for (int rk = 0; rk < sc.n_res_blks; ++rk) {
    const int bi = sc.res_blk[rk];
    const int lane_off = bi * 4;
    const float* const pc = sc.blk_c + bi * 64;
    float* const pec = sc.blk_hot + bi * 32;
    float* const pu = pec + 8;
    float* const pe = sc.blk_e + bi * 16;
    const float dpe = sc.blk_is_pe[bi] ? de_pe_diff_f : 0.0f;
    for (int l = 0; l < 4; ++l) {
      if (sc.blk_active[lane_off + l] == 0u) continue;
      const double mv = sc.blk_mf[lane_off + l];
      const double wv = sc.blk_w[lane_off + l], j = wv + sc.blk_q[lane_off + l];
      const double inv_psidot = 1.0 / (wv * wdot + j * mdot + mv * beta_dot);
      const double inv_psidot2 = inv_psidot * inv_psidot;
      const double ec = pc[24 + l] + pc[32 + l] * da, es = pc[28 + l] + pc[36 + l] * da;
      const double uc_base = pc[0 + l] + (-pc[8 + l] - 0.5 * pc[16 + l] * da) * da;
      const double us_base = pc[4 + l] + (-pc[12 + l] - 0.5 * pc[20 + l] * da) * da;
      const double uc_b = uc_base + ec * de_bake, us_b = us_base + es * de_bake;
      const double dc_b = pc[8 + l] + (pc[8 + l] + pc[16 + l]) * da - pc[32 + l] * de_bake;
      const double ds_b = pc[12 + l] + (pc[12 + l] + pc[20 + l]) * da - pc[36 + l] * de_bake;
      const double ec_ip = ec * inv_psidot, es_ip = es * inv_psidot;
      pe[0 + l] = static_cast<float>(pc[56 + l] * inv_psidot);
      pe[4 + l] = static_cast<float>(pc[60 + l] * inv_psidot);
      pe[8 + l] = static_cast<float>((-alpha_A * pc[32 + l] - beta_L * j * ec_ip) * inv_psidot);
      pe[12 + l] = static_cast<float>((-alpha_A * pc[36 + l] - beta_L * j * es_ip) * inv_psidot);
      pec[0 + l] = static_cast<float>(ec_ip);
      pec[4 + l] = static_cast<float>(es_ip);
      pu[0 + l] = static_cast<float>(uc_b * inv_psidot);
      pu[4 + l] = static_cast<float>(us_b * inv_psidot);
      pu[8 + l] = static_cast<float>((pc[40 + l] + pc[48 + l] * da + pc[56 + l] * de_bake) * inv_psidot) + pe[0 + l] * dpe;
      pu[12 + l] = static_cast<float>((pc[44 + l] + pc[52 + l] * da + pc[60 + l] * de_bake) * inv_psidot) + pe[4 + l] * dpe;
      pu[16 + l] = static_cast<float>(alpha_A * dc_b * inv_psidot - beta_L * j * uc_b * inv_psidot2) + pe[8 + l] * dpe;
      pu[20 + l] = static_cast<float>(alpha_A * ds_b * inv_psidot - beta_L * j * us_b * inv_psidot2) + pe[12 + l] * dpe;
    }
  }
#endif
}

template <bool kNeedD2>
[[gnu::noinline]] inline void sp_six_deriv_impl(const SpEvalCache& sc, float de_f32, double a, double e, double n,
                                                double eta, double eta_m1, double ci_p0, double sin_i, double ci,
                                                double ia, double inv_1peta, const float* cswq_c, const float* cswq_s,
                                                const float* cm_f32, const float* sm_f32,
                                                double* six, double* dsix_dlam, double* d2six_dlam2) {
  const int nblks = sc.total_blks, b_contig_end = sc.b_contig_end;
  double sM = 0.0, s1_num = 0.0, s2_num = 0.0, sE = 0.0, sI = 0.0, sL = 0.0;
  double dsM = 0.0, ds1_num = 0.0, ds2_num = 0.0, dsE = 0.0, dsI = 0.0, dsL = 0.0;
  double d2sM = 0.0, d2s1_num = 0.0, d2s2_num = 0.0, d2sE = 0.0, d2sI = 0.0, d2sL = 0.0;
#ifdef __wasm_simd128__
  auto hsum_f32x4 = [](v128_t v) -> double {
    const v128_t d = wasm_f64x2_add(wasm_f64x2_promote_low_f32x4(v),
                                    wasm_f64x2_promote_low_f32x4(wasm_i64x2_shuffle(v, v, 1, 0)));
    return wasm_f64x2_extract_lane(d, 0) + wasm_f64x2_extract_lane(d, 1);
  };
  const v128_t v_de = wasm_f32x4_splat(de_f32);
  v128_t vg_w = wasm_f32x4_splat(0.0f),   vg_q = wasm_f32x4_splat(0.0f),   vg_m = wasm_f32x4_splat(0.0f);
  v128_t vg_sE = wasm_f32x4_splat(0.0f),  vg_sI = wasm_f32x4_splat(0.0f),  vg_sL = wasm_f32x4_splat(0.0f);
  v128_t vdg_w = wasm_f32x4_splat(0.0f),  vdg_q = wasm_f32x4_splat(0.0f),  vdg_m = wasm_f32x4_splat(0.0f);
  v128_t vdg_sE = wasm_f32x4_splat(0.0f), vdg_sI = wasm_f32x4_splat(0.0f), vdg_sL = wasm_f32x4_splat(0.0f);
  v128_t vd2_w = wasm_f32x4_splat(0.0f),  vd2_q = wasm_f32x4_splat(0.0f),  vd2_m = wasm_f32x4_splat(0.0f);
  v128_t vd2_sE = wasm_f32x4_splat(0.0f), vd2_sI = wasm_f32x4_splat(0.0f), vd2_sL = wasm_f32x4_splat(0.0f);
  const v128_t* vhot = reinterpret_cast<const v128_t*>(sc.blk_hot);
  const v128_t* vpe = reinterpret_cast<const v128_t*>(sc.blk_e);
  const v128_t* const vmseq_base = reinterpret_cast<const v128_t*>(kSpMSeq);
  const int nrows = sc.n_rows;
  int bi = 0;
  for (int ri = 0; ri < nrows; ++ri) {
    const SpRow& row = sc.rows[ri];
    const int bend = row.blk_end;
    const uint8_t wq0 = row.wq0;
    const v128_t cw = wasm_v128_load32_splat(cswq_c + wq0);
    const v128_t sw = wasm_v128_load32_splat(cswq_s + wq0);
    const float* pcm = cm_f32 + (static_cast<int>(row.c_start) << 2);
    const float* psm = sm_f32 + (static_cast<int>(row.c_start) << 2);
    const v128_t* pmf = vmseq_base + row.c_start;
    v128_t vr_idS = wasm_f32x4_splat(0.0f), vr_didS_u = wasm_f32x4_splat(0.0f);
    v128_t vr_m_idS = wasm_f32x4_splat(0.0f), vr_m_didS_u = wasm_f32x4_splat(0.0f);
    v128_t vr_sE = wasm_f32x4_splat(0.0f), vr_sI = wasm_f32x4_splat(0.0f), vr_sL = wasm_f32x4_splat(0.0f);
    v128_t vr_dsE = wasm_f32x4_splat(0.0f), vr_dsI = wasm_f32x4_splat(0.0f), vr_dsL = wasm_f32x4_splat(0.0f);
    for (; bi < bend; ++bi, vhot += 8, vpe += 4, pcm += 4, psm += 4, ++pmf) {
      const v128_t v_cm = wasm_v128_load(pcm), v_sm = wasm_v128_load(psm);
      const v128_t v_cp = wasm_f32x4_sub(wasm_f32x4_mul(cw, v_cm), wasm_f32x4_mul(sw, v_sm));
      const v128_t v_sp = wasm_f32x4_add(wasm_f32x4_mul(sw, v_cm), wasm_f32x4_mul(cw, v_sm));
      const v128_t v_ec = vhot[0], v_es = vhot[1];
      const v128_t v_uc = wasm_f32x4_add(vhot[2], wasm_f32x4_mul(v_ec, v_de));
      const v128_t v_us = wasm_f32x4_add(vhot[3], wasm_f32x4_mul(v_es, v_de));
      const v128_t v_ic = wasm_f32x4_add(vhot[4], wasm_f32x4_mul(vpe[0], v_de));
      const v128_t v_is = wasm_f32x4_add(vhot[5], wasm_f32x4_mul(vpe[1], v_de));
      const v128_t v_lc = wasm_f32x4_add(vhot[6], wasm_f32x4_mul(vpe[2], v_de));
      const v128_t v_ls = wasm_f32x4_add(vhot[7], wasm_f32x4_mul(vpe[3], v_de));
      const v128_t v_mf = *pmf;
      const v128_t idS_b = wasm_f32x4_add(wasm_f32x4_mul(v_uc, v_cp), wasm_f32x4_mul(v_us, v_sp));
      const v128_t didS_u = wasm_f32x4_sub(wasm_f32x4_mul(v_us, v_cp), wasm_f32x4_mul(v_uc, v_sp));
      vr_idS = wasm_f32x4_add(vr_idS, idS_b);
      vr_didS_u = wasm_f32x4_add(vr_didS_u, didS_u);
      vr_m_idS = wasm_f32x4_add(vr_m_idS, wasm_f32x4_mul(v_mf, idS_b));
      vr_m_didS_u = wasm_f32x4_add(vr_m_didS_u, wasm_f32x4_mul(v_mf, didS_u));
      vr_sE = wasm_f32x4_add(vr_sE, wasm_f32x4_sub(wasm_f32x4_mul(v_ec, v_sp), wasm_f32x4_mul(v_es, v_cp)));
      vr_sI = wasm_f32x4_add(vr_sI, wasm_f32x4_sub(wasm_f32x4_mul(v_ic, v_sp), wasm_f32x4_mul(v_is, v_cp)));
      vr_sL = wasm_f32x4_add(vr_sL, wasm_f32x4_sub(wasm_f32x4_mul(v_lc, v_sp), wasm_f32x4_mul(v_ls, v_cp)));
      vr_dsE = wasm_f32x4_add(vr_dsE, wasm_f32x4_add(wasm_f32x4_mul(v_ec, v_cp), wasm_f32x4_mul(v_es, v_sp)));
      vr_dsI = wasm_f32x4_add(vr_dsI, wasm_f32x4_add(wasm_f32x4_mul(v_ic, v_cp), wasm_f32x4_mul(v_is, v_sp)));
      vr_dsL = wasm_f32x4_add(vr_dsL, wasm_f32x4_add(wasm_f32x4_mul(v_lc, v_cp), wasm_f32x4_mul(v_ls, v_sp)));
    }
    const v128_t v_wf = wasm_v128_load32_splat(&row.wf);
    const v128_t v_qf = wasm_v128_load32_splat(&row.qf);
    const v128_t v_jf = wasm_v128_load32_splat(&row.jf);
    vg_w = wasm_f32x4_add(vg_w, wasm_f32x4_mul(v_wf, vr_idS));
    vg_q = wasm_f32x4_add(vg_q, wasm_f32x4_mul(v_qf, vr_idS));
    vg_m = wasm_f32x4_add(vg_m, vr_m_idS);
    vg_sE = wasm_f32x4_add(vg_sE, vr_sE);
    vg_sI = wasm_f32x4_add(vg_sI, vr_sI);
    vg_sL = wasm_f32x4_add(vg_sL, vr_sL);
    const v128_t vr_didS = wasm_f32x4_mul(v_jf, vr_didS_u);
    vdg_w = wasm_f32x4_add(vdg_w, wasm_f32x4_mul(v_wf, vr_didS));
    vdg_q = wasm_f32x4_add(vdg_q, wasm_f32x4_mul(v_qf, vr_didS));
    vdg_m = wasm_f32x4_add(vdg_m, wasm_f32x4_mul(v_jf, vr_m_didS_u));
    vdg_sE = wasm_f32x4_add(vdg_sE, wasm_f32x4_mul(v_jf, vr_dsE));
    vdg_sI = wasm_f32x4_add(vdg_sI, wasm_f32x4_mul(v_jf, vr_dsI));
    vdg_sL = wasm_f32x4_add(vdg_sL, wasm_f32x4_mul(v_jf, vr_dsL));
    if constexpr (kNeedD2) {
      const v128_t v_nj2 = wasm_f32x4_neg(wasm_f32x4_mul(v_jf, v_jf));
      const v128_t vr_d2idS = wasm_f32x4_mul(v_nj2, vr_idS);
      vd2_w = wasm_f32x4_add(vd2_w, wasm_f32x4_mul(v_wf, vr_d2idS));
      vd2_q = wasm_f32x4_add(vd2_q, wasm_f32x4_mul(v_qf, vr_d2idS));
      vd2_m = wasm_f32x4_add(vd2_m, wasm_f32x4_mul(v_nj2, vr_m_idS));
      vd2_sE = wasm_f32x4_add(vd2_sE, wasm_f32x4_mul(v_nj2, vr_sE));
      vd2_sI = wasm_f32x4_add(vd2_sI, wasm_f32x4_mul(v_nj2, vr_sI));
      vd2_sL = wasm_f32x4_add(vd2_sL, wasm_f32x4_mul(v_nj2, vr_sL));
    }
  }
  (void)b_contig_end;
  for (; bi < nblks; ++bi, vhot += 8, vpe += 4) {
    const int lo = bi * 4;
    const uint8_t* wqp = sc.blk_wq + lo;
    const uint8_t* mp = sc.blk_mlane + lo;
    const v128_t v_cwj = wasm_f32x4_make(cswq_c[wqp[0]], cswq_c[wqp[1]], cswq_c[wqp[2]], cswq_c[wqp[3]]);
    const v128_t v_swj = wasm_f32x4_make(cswq_s[wqp[0]], cswq_s[wqp[1]], cswq_s[wqp[2]], cswq_s[wqp[3]]);
    const v128_t v_cm  = wasm_f32x4_make(cm_f32[mp[0]],  cm_f32[mp[1]],  cm_f32[mp[2]],  cm_f32[mp[3]]);
    const v128_t v_sm  = wasm_f32x4_make(sm_f32[mp[0]],  sm_f32[mp[1]],  sm_f32[mp[2]],  sm_f32[mp[3]]);
    const v128_t v_cp = wasm_f32x4_sub(wasm_f32x4_mul(v_cwj, v_cm), wasm_f32x4_mul(v_swj, v_sm));
    const v128_t v_sp = wasm_f32x4_add(wasm_f32x4_mul(v_swj, v_cm), wasm_f32x4_mul(v_cwj, v_sm));
    const v128_t v_ec = vhot[0], v_es = vhot[1];
    const v128_t v_uc = wasm_f32x4_add(vhot[2], wasm_f32x4_mul(v_ec, v_de));
    const v128_t v_us = wasm_f32x4_add(vhot[3], wasm_f32x4_mul(v_es, v_de));
    const v128_t v_ic = wasm_f32x4_add(vhot[4], wasm_f32x4_mul(vpe[0], v_de));
    const v128_t v_is = wasm_f32x4_add(vhot[5], wasm_f32x4_mul(vpe[1], v_de));
    const v128_t v_lc = wasm_f32x4_add(vhot[6], wasm_f32x4_mul(vpe[2], v_de));
    const v128_t v_ls = wasm_f32x4_add(vhot[7], wasm_f32x4_mul(vpe[3], v_de));
    const v128_t v_wf = wasm_v128_load(sc.blk_w + lo);
    const v128_t v_qf = wasm_v128_load(sc.blk_q + lo);
    const v128_t v_jf = wasm_f32x4_add(v_wf, v_qf);
    const v128_t v_mf = wasm_v128_load(sc.blk_mf + lo);
    const v128_t idS_b = wasm_f32x4_add(wasm_f32x4_mul(v_uc, v_cp), wasm_f32x4_mul(v_us, v_sp));
    const v128_t didS_b = wasm_f32x4_mul(v_jf, wasm_f32x4_sub(wasm_f32x4_mul(v_us, v_cp), wasm_f32x4_mul(v_uc, v_sp)));
    const v128_t tE_b = wasm_f32x4_sub(wasm_f32x4_mul(v_ec, v_sp), wasm_f32x4_mul(v_es, v_cp));
    const v128_t tI_b = wasm_f32x4_sub(wasm_f32x4_mul(v_ic, v_sp), wasm_f32x4_mul(v_is, v_cp));
    const v128_t tL_b = wasm_f32x4_sub(wasm_f32x4_mul(v_lc, v_sp), wasm_f32x4_mul(v_ls, v_cp));
    vg_w = wasm_f32x4_add(vg_w, wasm_f32x4_mul(v_wf, idS_b));
    vg_q = wasm_f32x4_add(vg_q, wasm_f32x4_mul(v_qf, idS_b));
    vg_m = wasm_f32x4_add(vg_m, wasm_f32x4_mul(v_mf, idS_b));
    vg_sE = wasm_f32x4_add(vg_sE, tE_b);
    vg_sI = wasm_f32x4_add(vg_sI, tI_b);
    vg_sL = wasm_f32x4_add(vg_sL, tL_b);
    vdg_w = wasm_f32x4_add(vdg_w, wasm_f32x4_mul(v_wf, didS_b));
    vdg_q = wasm_f32x4_add(vdg_q, wasm_f32x4_mul(v_qf, didS_b));
    vdg_m = wasm_f32x4_add(vdg_m, wasm_f32x4_mul(v_mf, didS_b));
    vdg_sE = wasm_f32x4_add(vdg_sE, wasm_f32x4_mul(v_jf, wasm_f32x4_add(wasm_f32x4_mul(v_ec, v_cp), wasm_f32x4_mul(v_es, v_sp))));
    vdg_sI = wasm_f32x4_add(vdg_sI, wasm_f32x4_mul(v_jf, wasm_f32x4_add(wasm_f32x4_mul(v_ic, v_cp), wasm_f32x4_mul(v_is, v_sp))));
    vdg_sL = wasm_f32x4_add(vdg_sL, wasm_f32x4_mul(v_jf, wasm_f32x4_add(wasm_f32x4_mul(v_lc, v_cp), wasm_f32x4_mul(v_ls, v_sp))));
    if constexpr (kNeedD2) {
      const v128_t nj2 = wasm_f32x4_neg(wasm_f32x4_mul(v_jf, v_jf));
      const v128_t d2idS = wasm_f32x4_mul(nj2, idS_b);
      vd2_w = wasm_f32x4_add(vd2_w, wasm_f32x4_mul(v_wf, d2idS));
      vd2_q = wasm_f32x4_add(vd2_q, wasm_f32x4_mul(v_qf, d2idS));
      vd2_m = wasm_f32x4_add(vd2_m, wasm_f32x4_mul(v_mf, d2idS));
      vd2_sE = wasm_f32x4_add(vd2_sE, wasm_f32x4_mul(nj2, tE_b));
      vd2_sI = wasm_f32x4_add(vd2_sI, wasm_f32x4_mul(nj2, tI_b));
      vd2_sL = wasm_f32x4_add(vd2_sL, wasm_f32x4_mul(nj2, tL_b));
    }
  }
  double sum_w = hsum_f32x4(vg_w), sum_q = hsum_f32x4(vg_q), midS = hsum_f32x4(vg_m);
  sE = hsum_f32x4(vg_sE); sI = hsum_f32x4(vg_sI); sL = hsum_f32x4(vg_sL);
  double dsum_w = hsum_f32x4(vdg_w), dsum_q = hsum_f32x4(vdg_q), dmidS = hsum_f32x4(vdg_m);
  dsE = hsum_f32x4(vdg_sE); dsI = hsum_f32x4(vdg_sI); dsL = hsum_f32x4(vdg_sL);
  double d2sum_w = 0.0, d2sum_q = 0.0, d2midS = 0.0;
  if constexpr (kNeedD2) {
    d2sum_w = hsum_f32x4(vd2_w); d2sum_q = hsum_f32x4(vd2_q); d2midS = hsum_f32x4(vd2_m);
    d2sE = hsum_f32x4(vd2_sE); d2sI = hsum_f32x4(vd2_sI); d2sL = hsum_f32x4(vd2_sL);
  }
  sM = sum_w + sum_q;
  s1_num = eta * sum_q + eta_m1 * sum_w;
  s2_num = ci_p0 * sum_w - midS;
  dsM = dsum_w + dsum_q;
  ds1_num = eta * dsum_q + eta_m1 * dsum_w;
  ds2_num = ci_p0 * dsum_w - dmidS;
  if constexpr (kNeedD2) {
    d2sM = d2sum_w + d2sum_q;
    d2s1_num = eta * d2sum_q + eta_m1 * d2sum_w;
    d2s2_num = ci_p0 * d2sum_w - d2midS;
  }
#else
  (void)b_contig_end;
  double sum_w = 0.0, sum_q = 0.0, midS = 0.0;
  double dsum_w = 0.0, dsum_q = 0.0, dmidS = 0.0;
  double d2sum_w = 0.0, d2sum_q = 0.0, d2midS = 0.0;
  const float* pec = sc.blk_hot;
  const float* pu = pec + 8;
  const float* pe = sc.blk_e;
  for (int bi = 0; bi < nblks; ++bi, pec += 32, pu += 32, pe += 16) {
    const int lane_off = bi * 4;
    for (int l = 0; l < 4; ++l) {
      if (sc.blk_active[lane_off + l] == 0u) continue;
      const int m_idx = sc.blk_mlane[lane_off + l];
      const int wq_idx = sc.blk_wq[lane_off + l];
      const float cmv = cm_f32[m_idx], smv = sm_f32[m_idx];
      const float cs0 = cswq_c[wq_idx], cs1 = cswq_s[wq_idx];
      const float cp = cs0 * cmv - cs1 * smv;
      const float sp = cs1 * cmv + cs0 * smv;
      const float ec = pec[0 + l], es = pec[4 + l];
      const float uc = pu[0 + l] + ec * de_f32, us = pu[4 + l] + es * de_f32;
      const float ic = pu[8 + l] + pe[0 + l] * de_f32, is = pu[12 + l] + pe[4 + l] * de_f32;
      const float lc = pu[16 + l] + pe[8 + l] * de_f32, ls = pu[20 + l] + pe[12 + l] * de_f32;
      const double mv = sc.blk_mf[lane_off + l];
      const double wv = sc.blk_w[lane_off + l], qv = sc.blk_q[lane_off + l], jf = wv + qv;
      const double idS = uc * cp + us * sp, didS = jf * (us * cp - uc * sp);
      const double tE = ec * sp - es * cp, tI = ic * sp - is * cp, tL = lc * sp - ls * cp;
      sum_w += wv * idS; sum_q += qv * idS; midS += mv * idS;
      sE += tE; sI += tI; sL += tL;
      dsum_w += wv * didS; dsum_q += qv * didS; dmidS += mv * didS;
      dsE += jf * (ec * cp + es * sp); dsI += jf * (ic * cp + is * sp); dsL += jf * (lc * cp + ls * sp);
      if constexpr (kNeedD2) {
        const double nj2 = -(jf * jf);
        d2sum_w += nj2 * wv * idS; d2sum_q += nj2 * qv * idS; d2midS += nj2 * mv * idS;
        d2sE += nj2 * tE; d2sI += nj2 * tI; d2sL += nj2 * tL;
      }
    }
  }
  sM = sum_w + sum_q;
  s1_num = eta * sum_q + eta_m1 * sum_w; s2_num = ci_p0 * sum_w - midS;
  dsM = dsum_w + dsum_q;
  ds1_num = eta * dsum_q + eta_m1 * dsum_w; ds2_num = ci_p0 * dsum_w - dmidS;
  if constexpr (kNeedD2) {
    d2sM = d2sum_w + d2sum_q;
    d2s1_num = eta * d2sum_q + eta_m1 * d2sum_w; d2s2_num = ci_p0 * d2sum_w - d2midS;
  }
#endif
  const double na2 = n * a * a;
#ifdef __wasm_simd128__
  const v128_t v_one_d = wasm_f64x2_splat(1.0);
  const v128_t v_r1 = wasm_f64x2_div(v_one_d, wasm_f64x2_make(1.0 + ci, sin_i));
  const v128_t v_r2 = wasm_f64x2_div(v_one_d, wasm_f64x2_make(na2 * e, na2 * eta));
  const double inv_1pci = wasm_f64x2_extract_lane(v_r1, 0);
  const double inv_sini = wasm_f64x2_extract_lane(v_r1, 1);
  const double inv_na2e = wasm_f64x2_extract_lane(v_r2, 0);
  const double inv_na2eta = wasm_f64x2_extract_lane(v_r2, 1);
#else
  const double inv_1pci = 1.0 / (1.0 + ci);
  const double inv_sini = 1.0 / sin_i;
  const double inv_na2e = 1.0 / (na2 * e);
  const double inv_na2eta = 1.0 / (na2 * eta);
#endif
  const double tanhalf = sin_i * inv_1pci;
  const double k0 = -3.0 * ia * ia;
  const double k1 = eta * inv_na2e;
  const double k2 = inv_na2eta * inv_sini;
  const double kE = (eta * eta) * inv_na2eta;
  const double kEI = e * tanhalf * inv_na2eta;
  const double kLE = (e * inv_1peta) * kE;
  const double kLI = tanhalf * inv_na2eta;
  six[0] += k0 * sM;
  six[1] += k1 * s1_num;
  six[2] += k2 * s2_num;
  six[3] += kE * sE + kEI * sI;
  six[4] += inv_na2eta * sI;
  six[5] += sL + kLE * sE + kLI * sI;
  dsix_dlam[0] += k0 * dsM;
  dsix_dlam[1] += k1 * ds1_num;
  dsix_dlam[2] += k2 * ds2_num;
  dsix_dlam[3] += kE * dsE + kEI * dsI;
  dsix_dlam[4] += inv_na2eta * dsI;
  dsix_dlam[5] += dsL + kLE * dsE + kLI * dsI;
  if constexpr (kNeedD2) {
    d2six_dlam2[0] += k0 * d2sM;
    d2six_dlam2[1] += k1 * d2s1_num;
    d2six_dlam2[2] += k2 * d2s2_num;
    d2six_dlam2[3] += kE * d2sE + kEI * d2sI;
    d2six_dlam2[4] += inv_na2eta * d2sI;
    d2six_dlam2[5] += d2sL + kLE * d2sE + kLI * d2sI;
  }
}

inline void sp_six_deriv(const SpEvalCache& sc, float de_f32, double a, double e, double n,
                         double eta, double eta_m1, double ci_p0, double sin_i, double ci,
                         double ia, double inv_1peta, const float* cswq_c, const float* cswq_s,
                         const float* cm_f32, const float* sm_f32,
                         double* six, double* dsix_dlam, double* d2six_dlam2) {
  if (d2six_dlam2 != nullptr) {
    sp_six_deriv_impl<true>(sc, de_f32, a, e, n, eta, eta_m1, ci_p0, sin_i, ci, ia, inv_1peta,
                            cswq_c, cswq_s, cm_f32, sm_f32, six, dsix_dlam, d2six_dlam2);
  } else {
    sp_six_deriv_impl<false>(sc, de_f32, a, e, n, eta, eta_m1, ci_p0, sin_i, ci, ia, inv_1peta,
                             cswq_c, cswq_s, cm_f32, sm_f32, six, dsix_dlam, nullptr);
  }
}

[[gnu::noinline]] inline void sp_sync(SpEvalCache& sc, double a0, double e0, double a, double e, double ci, double t,
                                      bool derivative) {
  const SpAnchor& an = g_sp_anchor;
  const bool anchored = sp_anchored(t);
  const uint64_t aid = anchored ? an.id : 0;
  const double ctol = e0 < 0.03 ? 1.5e-4 : 6e-5;
  double a_b, e_b, ci_b, a_ae, e_ae, c_ae, e_pe = 0.0, a_pe, c_pe;
  int64_t kba, kbe = 0, kbc = 0, kaa, kae = 0, kpe = kSpPeAtBake;
  if (anchored) {
    kba = sp_anchor_point(an, t, 3e-5, 2e-5, true, ctol, a_b, e_b, ci_b);
    kaa = sp_anchor_point(an, t, 1.8e-6, 2e-5, false, 0.0, a_ae, e_ae, c_ae);
    if (!derivative && sc.n_pe_blks > 0) kpe = sp_anchor_point(an, t, 1e30, sc.de_pe_thresh, false, 0.0, a_pe, e_pe, c_pe);
  } else {
    kba = sp_cell_rel(a, 3e-5, a_b);
    kbe = sp_cell_e(e, 2.5e-4, 2e-5, e_b);
    kbc = sp_cell_abs(ci, ctol, ci_b);
    kaa = sp_cell_rel(a, 1.8e-6, a_ae);
    kae = sp_cell_abs(e, 2e-5, e_ae);
    if (!derivative && sc.n_pe_blks > 0) kpe = sp_cell_abs(e, sc.de_pe_thresh, e_pe);
  }
  const bool fresh = !sc.keys_valid || sc.anchor_id != aid;
  const bool base = fresh || kba != sc.kb_a || kbe != sc.kb_e || kbc != sc.kb_c;
  bool ae = base || kaa != sc.kae_a || kae != sc.kae_e;
  const bool pe = ae || kpe != sc.kpe;
  if (pe && !ae && sc.e_pe_bake != sc.e_bake) ae = true;  // the pe blocks back to the ae bake's e: the ae bake again
  double a_r = 0.0, ci_r = 0.0, e_r = 0.0;
  int64_t kra = 0, krc = 0, kre = 0;
  auto res_point = [&]() {
    if (anchored) {
      kra = sp_anchor_point(an, t, 2e-7, 1e-5, true, 1e-6, a_r, e_r, ci_r);
    } else {
      kra = sp_cell_rel(a, 2e-7, a_r);
      krc = sp_cell_abs(ci, 1e-6, ci_r);
      kre = sp_cell_e(e, 1.25e-4, 1e-5, e_r);
    }
  };
  bool res = false;
  if (!base && sc.n_res_blks > 0) {
    res_point();
    res = pe || kra != sc.kr_a || krc != sc.kr_c || kre != sc.kr_e;
  }
  // what sp_keys_hold compares with: the keys the cache holds when this call returns (kept, or baked now)
  auto note_keys = [&]() {
    sc.on_bracket = anchored;
    if (!anchored) return;
    sc.kb_tlo = an.tlo;
    sc.kb_h = an.h;
    sc.n_base = static_cast<int32_t>(kba >> 6);
    sc.n_ae = static_cast<int32_t>(kaa >> 6);
    sc.n_pe = kpe != kSpPeAtBake ? static_cast<int32_t>(kpe >> 6) : 0;
    sc.n_res = sc.n_res_blks > 0 ? static_cast<int32_t>(kra >> 6) : 0;
  };
  if (!base && !ae && !pe && !res) {
    note_keys();
    return;
  }
  float* const own_c = sc.blk_c;
  if (base && sc.compact) sc.blk_c = sp_compact_blk_c(sc);
  if (base) {
    const double n_b = kKe / (a_b * std::sqrt(a_b));
    sp_rebake_base(sc, a0, e0, a_b, e_b, n_b, std::sqrt(1.0 - e_b * e_b), ci_b, 1.0 / a_b);
    if (sc.n_res_blks > 0) {
      res_point();
      res = true;
    }
  }
  if (ae) sp_rebake_ae(sc, a0, a_ae, e_ae, 1.0 / a_ae, true);
  if (pe && kpe != kSpPeAtBake) sp_rebake_pe_fast(sc, e_pe);
  if (res) {
    // a resonant bake alone reads the resonant blocks' coefficients only
    if (sc.compact && sc.blk_c == nullptr) sc.blk_c = sp_compact_blk_c(sc, sc.res_blk, sc.n_res_blks);
    const double n_r = kKe / (a_r * std::sqrt(a_r));
    sp_rebake_res(sc, a0, e0, a_r, e_r, n_r, std::sqrt(1.0 - e_r * e_r), ci_r, 1.0 / a_r);
    sc.kr_a = kra;
    sc.kr_c = krc;
    sc.kr_e = kre;
  }
  if (sc.compact) sc.blk_c = own_c;
  sc.anchor_id = aid;
  sc.kb_a = kba;
  sc.kb_e = kbe;
  sc.kb_c = kbc;
  sc.kae_a = kaa;
  sc.kae_e = kae;
  sc.kpe = kpe;
  sc.keys_valid = true;
  note_keys();
}

[[gnu::always_inline]] inline bool sp_keys_hold(const SpEvalCache& sc, double t, bool derivative) {
  const SpAnchor& an = g_sp_anchor;
  if (!sc.on_bracket || !sc.keys_valid || !an.valid || an.h == 0.0 || an.id != sc.anchor_id || an.tlo != sc.kb_tlo ||
      an.h != sc.kb_h)
    return false;
  const double q = (t - an.tlo) / an.h;
  if (!(q >= 0.0 && q <= 1.0)) return false;
  if (sp_part_key(q, sc.n_base) != sc.kb_a || sc.kb_e != 0 || sc.kb_c != 0 || sp_part_key(q, sc.n_ae) != sc.kae_a || sc.kae_e != 0)
    return false;
  if (!derivative && sc.n_pe_blks > 0) {
    if (sc.n_pe == 0 || sp_part_key(q, sc.n_pe) != sc.kpe) return false;
  } else if (sc.kpe != kSpPeAtBake) {
    return false;
  }
  return sc.n_res_blks == 0 || (sp_part_key(q, sc.n_res) == sc.kr_a && sc.kr_c == 0 && sc.kr_e == 0);
}

#ifdef __wasm_simd128__
[[gnu::always_inline]] inline void sp_eval_simd_kernel(const SpEvalCache& sc, float de_f32, double out6[6]) {
  auto hsum_f32x4 = [](v128_t v) -> double {
    const v128_t d = wasm_f64x2_add(wasm_f64x2_promote_low_f32x4(v),
                                    wasm_f64x2_promote_low_f32x4(wasm_i64x2_shuffle(v, v, 1, 0)));
    return wasm_f64x2_extract_lane(d, 0) + wasm_f64x2_extract_lane(d, 1);
  };
  const float* const cswq_c = sc.cswq_c;
  const float* const cswq_s = sc.cswq_s;
  const float* const cm_f32 = sp_trig_cm();
  const float* const sm_f32 = sp_trig_sm();
  const v128_t* const vcm_base = reinterpret_cast<const v128_t*>(cm_f32);
  const v128_t* const vsm_base = reinterpret_cast<const v128_t*>(sm_f32);
  const v128_t* const vmseq_base = reinterpret_cast<const v128_t*>(kSpMSeq);
  const v128_t v_de = wasm_f32x4_splat(de_f32);
  v128_t vg_w = wasm_f32x4_splat(0.0f);
  v128_t vg_q = wasm_f32x4_splat(0.0f);
  v128_t vg_midS = wasm_f32x4_splat(0.0f), vg_sE = wasm_f32x4_splat(0.0f);
  v128_t vg_sI = wasm_f32x4_splat(0.0f),   vg_sL = wasm_f32x4_splat(0.0f);

  int bi = 0;
  const int nrows = sc.n_rows;
  const int nblks = sc.total_blks;
  const v128_t* vhot = reinterpret_cast<const v128_t*>(sc.blk_hot);

  for (int ri = 0; ri < nrows; ++ri) {
    const SpRow& row = sc.rows[ri];
    const int bend = row.blk_end;
    const uint8_t wq0 = row.wq0;
    const v128_t cw = wasm_v128_load32_splat(cswq_c + wq0);
    const v128_t sw = wasm_v128_load32_splat(cswq_s + wq0);
    const v128_t* pcm = vcm_base + row.c_start;
    const v128_t* psm = vsm_base + row.c_start;
    const v128_t* pmf = vmseq_base + row.c_start;
    v128_t vr_idS = wasm_f32x4_splat(0.0f);
    for (; bi < bend; ++bi, vhot += 8, ++pcm, ++psm, ++pmf) {
      const v128_t cm_ = *pcm, sm_ = *psm;
      const v128_t cp_ = wasm_f32x4_sub(wasm_f32x4_mul(cw, cm_), wasm_f32x4_mul(sw, sm_));
      const v128_t sp_ = wasm_f32x4_add(wasm_f32x4_mul(sw, cm_), wasm_f32x4_mul(cw, sm_));
      const v128_t ec_ = vhot[0], es_ = vhot[1];
      const v128_t uc_ = wasm_f32x4_add(vhot[2], wasm_f32x4_mul(ec_, v_de));
      const v128_t us_ = wasm_f32x4_add(vhot[3], wasm_f32x4_mul(es_, v_de));
      const v128_t idS_ = wasm_f32x4_add(wasm_f32x4_mul(uc_, cp_), wasm_f32x4_mul(us_, sp_));
      vr_idS = wasm_f32x4_add(vr_idS, idS_);
      vg_midS = wasm_f32x4_add(vg_midS, wasm_f32x4_mul(*pmf, idS_));
      vg_sE = wasm_f32x4_add(vg_sE, wasm_f32x4_sub(wasm_f32x4_mul(ec_, sp_), wasm_f32x4_mul(es_, cp_)));
      vg_sI = wasm_f32x4_add(vg_sI, wasm_f32x4_sub(wasm_f32x4_mul(vhot[4], sp_), wasm_f32x4_mul(vhot[5], cp_)));
      vg_sL = wasm_f32x4_add(vg_sL, wasm_f32x4_sub(wasm_f32x4_mul(vhot[6], sp_), wasm_f32x4_mul(vhot[7], cp_)));
    }
    vg_w = wasm_f32x4_add(vg_w, wasm_f32x4_mul(wasm_v128_load32_splat(&row.wf), vr_idS));
    vg_q = wasm_f32x4_add(vg_q, wasm_f32x4_mul(wasm_v128_load32_splat(&row.qf), vr_idS));
  }

  for (; bi < nblks; ++bi, vhot += 8) {
    const int lo = bi * 4;
    const uint8_t* wqp = sc.blk_wq + lo;
    const uint8_t* mp = sc.blk_mlane + lo;
    const v128_t v_cwj = wasm_f32x4_make(cswq_c[wqp[0]], cswq_c[wqp[1]], cswq_c[wqp[2]], cswq_c[wqp[3]]);
    const v128_t v_swj = wasm_f32x4_make(cswq_s[wqp[0]], cswq_s[wqp[1]], cswq_s[wqp[2]], cswq_s[wqp[3]]);
    const v128_t v_cm  = wasm_f32x4_make(cm_f32[mp[0]],  cm_f32[mp[1]],  cm_f32[mp[2]],  cm_f32[mp[3]]);
    const v128_t v_sm  = wasm_f32x4_make(sm_f32[mp[0]],  sm_f32[mp[1]],  sm_f32[mp[2]],  sm_f32[mp[3]]);
    const v128_t v_cp = wasm_f32x4_sub(wasm_f32x4_mul(v_cwj, v_cm), wasm_f32x4_mul(v_swj, v_sm));
    const v128_t v_sp = wasm_f32x4_add(wasm_f32x4_mul(v_swj, v_cm), wasm_f32x4_mul(v_cwj, v_sm));
    const v128_t v_ec = vhot[0], v_es = vhot[1];
    const v128_t v_uc = wasm_f32x4_add(vhot[2], wasm_f32x4_mul(v_ec, v_de));
    const v128_t v_us = wasm_f32x4_add(vhot[3], wasm_f32x4_mul(v_es, v_de));
    const v128_t v_idS = wasm_f32x4_add(wasm_f32x4_mul(v_uc, v_cp), wasm_f32x4_mul(v_us, v_sp));
    vg_w = wasm_f32x4_add(vg_w, wasm_f32x4_mul(wasm_v128_load(sc.blk_w + lo), v_idS));
    vg_q = wasm_f32x4_add(vg_q, wasm_f32x4_mul(wasm_v128_load(sc.blk_q + lo), v_idS));
    vg_midS = wasm_f32x4_add(vg_midS, wasm_f32x4_mul(wasm_v128_load(sc.blk_mf + lo), v_idS));
    vg_sE = wasm_f32x4_add(vg_sE, wasm_f32x4_sub(wasm_f32x4_mul(v_ec, v_sp), wasm_f32x4_mul(v_es, v_cp)));
    vg_sI = wasm_f32x4_add(vg_sI, wasm_f32x4_sub(wasm_f32x4_mul(vhot[4], v_sp), wasm_f32x4_mul(vhot[5], v_cp)));
    vg_sL = wasm_f32x4_add(vg_sL, wasm_f32x4_sub(wasm_f32x4_mul(vhot[6], v_sp), wasm_f32x4_mul(vhot[7], v_cp)));
  }
  out6[0] = hsum_f32x4(vg_w);
  out6[1] = hsum_f32x4(vg_q);
  out6[2] = hsum_f32x4(vg_midS);
  out6[3] = hsum_f32x4(vg_sE);
  out6[4] = hsum_f32x4(vg_sI);
  out6[5] = hsum_f32x4(vg_sL);
}
#endif

[[gnu::noinline]] inline void sp_six_with_deriv(
    const SpCombCoef* F, int count, double a0, double e0, double t, const Kepler& kp, double n, double eta,
    double si, double ci, double ci_build, double theta_g0, double* six, double* dsix_dlam, double* d2six_dlam2,
    const double* sb_in = nullptr, const double* cb_in = nullptr,
    float* cm_f32_io = nullptr, float* sm_f32_io = nullptr, int cm_in_count = 0,
    double cm_last = 1.0, double sm_last = 0.0,
    const double* su1_in = nullptr, const double* cu1_in = nullptr,
    const double* sM1_in = nullptr, const double* cM1_in = nullptr) {
  if (count <= 0) return;
  const double a = kp.a, e = kp.e < 1e-12 ? 1e-12 : kp.e;
  const double sin_i = std::fabs(si) < 1e-12 ? (si < 0.0 ? -1e-12 : 1e-12) : si;
#ifdef __wasm_simd128__
  const v128_t v_one_d = wasm_f64x2_splat(1.0);
  const v128_t v_r0 = wasm_f64x2_div(v_one_d, wasm_f64x2_make(a, 1.0 + eta));
  const double ia = wasm_f64x2_extract_lane(v_r0, 0);
  const double inv_1peta = wasm_f64x2_extract_lane(v_r0, 1);
#else
  const double ia = 1.0 / a;
  const double inv_1peta = 1.0 / (1.0 + eta);
#endif
  uint32_t tag = static_cast<uint8_t>(F[0].pad);
  if (count >= 4) {
    tag |= (static_cast<uint32_t>(static_cast<uint8_t>(F[1].pad)) << 8) |
           (static_cast<uint32_t>(static_cast<uint8_t>(F[2].pad)) << 16) |
           (static_cast<uint32_t>(static_cast<uint8_t>(F[3].pad)) << 24);
  } else {
    for (int k = 1; k < count; ++k) tag |= static_cast<uint32_t>(static_cast<uint8_t>(F[k].pad)) << (8 * k);
  }
  SpSetSlot* const slot = g_sp_set_slot;
  SpEvalCache* scp = (slot != nullptr && slot->cache != nullptr) ? slot->cache : &sp_thread_cache();
  if (__builtin_expect(t == 0.0 || !sp_matches(*scp, F, count, tag, a0, e0), 0)) {
    SpEvalCache& th = sp_thread_cache();
    if (!sp_init_or_fallback(th, F, count, tag, a0, e0, t, kp, a, e, n, eta, sin_i, ci, ia, ci_build,
                             theta_g0, sb_in, cb_in, su1_in, cu1_in, sM1_in, cM1_in, six, dsix_dlam, d2six_dlam2)) {
      return;
    }
    scp = sp_claim(slot, th, F, count, tag, a0, e0);
  }
  SpEvalCache& sc = *scp;
  if (!sp_keys_hold(sc, t, true)) sp_sync(sc, a0, e0, a, e, ci, t, true);
  double sb, cb, su1, cu1, sM1, cM1;
  if (sb_in != nullptr && cb_in != nullptr && su1_in != nullptr && cu1_in != nullptr && sM1_in != nullptr && cM1_in != nullptr) {
    sb = *sb_in; cb = *cb_in;
    su1 = *su1_in; cu1 = *cu1_in;
    sM1 = *sM1_in; cM1 = *cM1_in;
  } else {
    if (sb_in != nullptr && cb_in != nullptr) { sb = *sb_in; cb = *cb_in; }
    else fm::sincos_fast(kp.node - (theta_g0 + kOmegaE * t), sb, cb);
#ifdef __wasm_simd128__
    if (su1_in == nullptr && cu1_in == nullptr && sM1_in == nullptr && cM1_in == nullptr) {
      v128_t vs2, vc2;
      fm::sincos2_f64x2(wasm_f64x2_make(kp.argp + kp.m, kp.m), vs2, vc2);
      su1 = wasm_f64x2_extract_lane(vs2, 0); cu1 = wasm_f64x2_extract_lane(vc2, 0);
      sM1 = wasm_f64x2_extract_lane(vs2, 1); cM1 = wasm_f64x2_extract_lane(vc2, 1);
    } else
#endif
    {
      if (su1_in != nullptr && cu1_in != nullptr) { su1 = *su1_in; cu1 = *cu1_in; }
      else fm::sincos_fast(kp.argp + kp.m, su1, cu1);
      if (sM1_in != nullptr && cM1_in != nullptr) { sM1 = *sM1_in; cM1 = *cM1_in; }
      else fm::sincos_fast(kp.m, sM1, cM1);
    }
  }
  float* const cm_f32 = cm_f32_io != nullptr ? cm_f32_io : sp_trig_cm();
  float* const sm_f32 = sm_f32_io != nullptr ? sm_f32_io : sp_trig_sm();
  sp_fill_trig(sc, cb, sb, cu1, su1, cM1, sM1, cm_f32, sm_f32,
               cm_f32_io != nullptr ? cm_in_count : 0, cm_last, sm_last, cm_f32_io != nullptr);
  const float de_f32 = static_cast<float>(e - sc.e_bake);
  const double eta_m1 = -(kp.e * kp.e) * inv_1peta;
  const double ci_p0 = (ci >= 0.0 ? -(si * si) / (1.0 + ci) : (ci - 1.0)) + 1.0;
#ifdef __wasm_simd128__
  if (__builtin_expect(dsix_dlam == nullptr && d2six_dlam2 == nullptr && cm_f32_io == nullptr, 0)) {
    double out6[6];
    sp_eval_simd_kernel(sc, de_f32, out6);
    const double sum_w = out6[0], sum_q = out6[1], sum_m = out6[2];
    const double sE = out6[3], sI = out6[4], sL = out6[5];
    const double na2 = n * a * a;
    const double inv_1pci = 1.0 / (1.0 + ci), inv_sini = 1.0 / sin_i;
    const double inv_na2e = 1.0 / (na2 * e), inv_na2eta = 1.0 / (na2 * eta);
    const double sM = sum_w + sum_q;
    const double s1_num = eta * sum_q + eta_m1 * sum_w;
    const double s2_num = ci_p0 * sum_w - sum_m;
    const double tanhalf = sin_i * inv_1pci;
    const double sI_na2eta = sI * inv_na2eta;
    const double eta_sE_na2 = ((eta * eta) * inv_na2eta) * sE;
    six[0] += -3.0 * ia * ia * sM;
    six[1] += (eta * s1_num) * inv_na2e;
    six[2] += (s2_num * inv_na2eta) * inv_sini;
    six[3] += eta_sE_na2 + (e * tanhalf) * sI_na2eta;
    six[4] += sI_na2eta;
    six[5] += sL + (e * inv_1peta) * eta_sE_na2 + tanhalf * sI_na2eta;
    return;
  }
#endif
  sp_six_deriv(sc, de_f32, a, e, n, eta, eta_m1, ci_p0, sin_i, ci, ia, inv_1peta,
               sc.cswq_c, sc.cswq_s, cm_f32, sm_f32, six, dsix_dlam, d2six_dlam2);
}

[[gnu::noinline]] inline void sp_six_val(
    const SpCombCoef* F, int count, double a0, double e0, double t, double kp_a, double kp_e, double n, double eta,
    double si, double ci, double ci_build, double* six,
    double sb, double cb, double su1, double cu1, double sM1, double cM1,
    int cm_in_count, double cm_last, double sm_last, bool has_ext_cm) {
  if (count <= 0) return;
  const double a = kp_a, e = kp_e < 1e-12 ? 1e-12 : kp_e;
  const double sin_i = std::fabs(si) < 1e-12 ? (si < 0.0 ? -1e-12 : 1e-12) : si;
#ifdef __wasm_simd128__
  const v128_t v_one_d = wasm_f64x2_splat(1.0);
  const v128_t v_r0 = wasm_f64x2_div(v_one_d, wasm_f64x2_make(a, 1.0 + eta));
  const double ia = wasm_f64x2_extract_lane(v_r0, 0);
  const double inv_1peta = wasm_f64x2_extract_lane(v_r0, 1);
#else
  const double ia = 1.0 / a;
  const double inv_1peta = 1.0 / (1.0 + eta);
#endif
  uint32_t tag = static_cast<uint8_t>(F[0].pad);
  if (__builtin_expect(count >= 4, 1)) {
    tag |= (static_cast<uint32_t>(static_cast<uint8_t>(F[1].pad)) << 8) |
           (static_cast<uint32_t>(static_cast<uint8_t>(F[2].pad)) << 16) |
           (static_cast<uint32_t>(static_cast<uint8_t>(F[3].pad)) << 24);
  } else {
    if (count >= 2) tag |= static_cast<uint32_t>(static_cast<uint8_t>(F[1].pad)) << 8;
    if (count == 3) tag |= static_cast<uint32_t>(static_cast<uint8_t>(F[2].pad)) << 16;
  }
  SpSetSlot* const slot = g_sp_set_slot;
  SpEvalCache* scp = (slot != nullptr && slot->cache != nullptr) ? slot->cache : &sp_thread_cache();
  if (__builtin_expect(t == 0.0 || !sp_matches(*scp, F, count, tag, a0, e0), 0)) {
    SpEvalCache& th = sp_thread_cache();
    if (!sp_init_or_fallback_val(th, F, count, tag, a0, e0, t, a, e, n, eta, sin_i, ci, ia, ci_build,
                                 sb, cb, su1, cu1, sM1, cM1, six)) {
      return;
    }
    scp = sp_claim(slot, th, F, count, tag, a0, e0);
  }
  SpEvalCache& sc = *scp;
  if (!sp_keys_hold(sc, t, false)) sp_sync(sc, a0, e0, a, e, ci, t, false);

  float* const cm_f32 = sp_trig_cm();
  float* const sm_f32 = sp_trig_sm();
  sp_fill_trig(sc, cb, sb, cu1, su1, cM1, sM1, cm_f32, sm_f32,
               has_ext_cm ? cm_in_count : 0, cm_last, sm_last, has_ext_cm);
  const float de_f32 = static_cast<float>(e - sc.e_bake);

#ifdef __wasm_simd128__
  double out6[6];
  sp_eval_simd_kernel(sc, de_f32, out6);
  const double sum_w = out6[0], sum_q = out6[1], sum_m = out6[2];
  const double sE = out6[3], sI = out6[4], sL = out6[5];
  const double na2 = n * a * a;
  const v128_t v_r1 = wasm_f64x2_div(v_one_d, wasm_f64x2_make(1.0 + ci, sin_i));
  const v128_t v_r2 = wasm_f64x2_div(v_one_d, wasm_f64x2_make(na2 * e, na2 * eta));
  const double inv_1pci = wasm_f64x2_extract_lane(v_r1, 0);
  const double inv_sini = wasm_f64x2_extract_lane(v_r1, 1);
  const double inv_na2e = wasm_f64x2_extract_lane(v_r2, 0);
  const double inv_na2eta = wasm_f64x2_extract_lane(v_r2, 1);
  const double eta_m1 = -(kp_e * kp_e) * inv_1peta;
  const double ci_p0 = (ci >= 0.0 ? -(si * si) * inv_1pci : (ci - 1.0)) + 1.0;
  const double sM = sum_w + sum_q;
  const double s1_num = eta * sum_q + eta_m1 * sum_w;
  const double s2_num = ci_p0 * sum_w - sum_m;
  const double tanhalf = sin_i * inv_1pci;
  const double sI_na2eta = sI * inv_na2eta;
  const double eta_sE_na2 = ((eta * eta) * inv_na2eta) * sE;
  six[0] += -3.0 * ia * ia * sM;
  six[1] += (eta * s1_num) * inv_na2e;
  six[2] += (s2_num * inv_na2eta) * inv_sini;
  six[3] += eta_sE_na2 + (e * tanhalf) * sI_na2eta;
  six[4] += sI_na2eta;
  six[5] += sL + (e * inv_1peta) * eta_sE_na2 + tanhalf * sI_na2eta;
#else
  const float* const cswq_c = sc.cswq_c;
  const float* const cswq_s = sc.cswq_s;
  const int nblks = sc.total_blks;
  double sM = 0.0, s1_num = 0.0, s2_num = 0.0, sE = 0.0, sI = 0.0, sL = 0.0;
  const double eta_m1 = -(kp_e * kp_e) * inv_1peta;
  const double ci_p0 = (ci >= 0.0 ? -(si * si) / (1.0 + ci) : (ci - 1.0)) + 1.0;
  double sum_w = 0.0, sum_q = 0.0, midS = 0.0;
  const float* pec = sc.blk_hot;
  const float* pu = pec + 8;
  const float* pe = sc.blk_e;
  for (int bi = 0; bi < nblks; ++bi, pec += 32, pu += 32, pe += 16) {
    const int lane_off = bi * 4;
    for (int l = 0; l < 4; ++l) {
      if (sc.blk_active[lane_off + l] == 0u) continue;
      const int m_idx = sc.blk_mlane[lane_off + l];
      const int wq_idx = sc.blk_wq[lane_off + l];
      const float cmv = cm_f32[m_idx], smv = sm_f32[m_idx];
      const float cs0 = cswq_c[wq_idx], cs1 = cswq_s[wq_idx];
      const float cp = cs0 * cmv - cs1 * smv;
      const float sp = cs1 * cmv + cs0 * smv;
      const float ec = pec[0 + l], es = pec[4 + l];
      const float idS = (pu[0 + l] + ec * de_f32) * cp + (pu[4 + l] + es * de_f32) * sp;
      sum_w += static_cast<double>(sc.blk_w[lane_off + l]) * idS;
      sum_q += static_cast<double>(sc.blk_q[lane_off + l]) * idS;
      midS += static_cast<double>(sc.blk_mf[lane_off + l]) * idS;
      sE += ec * sp - es * cp;
      sI += (pu[8 + l] + pe[0 + l] * de_f32) * sp - (pu[12 + l] + pe[4 + l] * de_f32) * cp;
      sL += (pu[16 + l] + pe[8 + l] * de_f32) * sp - (pu[20 + l] + pe[12 + l] * de_f32) * cp;
    }
  }
  sM = sum_w + sum_q;
  s1_num = eta * sum_q + eta_m1 * sum_w;
  s2_num = ci_p0 * sum_w - midS;
  const double na2 = n * a * a;
  const double tanhalf = sin_i / (1.0 + ci);
  six[0] += -3.0 * ia * ia * sM;
  six[1] += (eta * s1_num) / (na2 * e);
  six[2] += s2_num / (na2 * eta * sin_i);
  six[3] += (eta / na2) * sE + e * tanhalf / (na2 * eta) * sI;
  six[4] += sI / (na2 * eta);
  six[5] += sL + (eta * e / (na2 * (1.0 + eta))) * sE + (tanhalf / (na2 * eta)) * sI;
#endif
}
