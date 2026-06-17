/*
 ISC License

 Copyright (c) 2021, Autonomous Vehicle Systems Lab, University of Colorado at Boulder

 Permission to use, copy, modify, and/or distribute this software for any
 purpose with or without fee is hereby granted, provided that the above
 copyright notice and this permission notice appear in all copies.

 THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

 This module ports selected Basilisk rigidBodyKinematics.c MRP, Gibbs, PRV,
 Euler-angle, Euler-parameter, DCM, first/second-order MRP differential, and
 avsEigenSupport elementary-matrix and tilde-matrix utilities to the SDK's
 standalone C++/WASI surface and SDS RBK FlatBuffer envelopes.
 */

#include "space_data_module_invoke.h"

#include <cmath>
#include <cstdint>
#include <cstring>
#include <string>

namespace {

constexpr double kSingularTolerance = 1e-15;
constexpr double kNearZero = 1e-12;

struct Vec3 {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
};

struct Quat {
  double q0 = 0.0;
  double q1 = 0.0;
  double q2 = 0.0;
  double q3 = 0.0;
};

struct Matrix3 {
  double m11 = 0.0;
  double m12 = 0.0;
  double m13 = 0.0;
  double m21 = 0.0;
  double m22 = 0.0;
  double m23 = 0.0;
  double m31 = 0.0;
  double m32 = 0.0;
  double m33 = 0.0;
};

struct OperationResult {
  rbkResultStatus status = rbkResultStatus_OK;
  const char* message = nullptr;
  bool has_vector = false;
  bool has_quaternion = false;
  bool has_matrix = false;
  Vec3 vector;
  Quat quaternion;
  Matrix3 matrix;
};

bool is_finite(double value) {
  return std::isfinite(value);
}

bool is_finite(const Vec3& value) {
  return is_finite(value.x) && is_finite(value.y) && is_finite(value.z);
}

bool is_finite(const Quat& value) {
  return is_finite(value.q0) && is_finite(value.q1) && is_finite(value.q2) && is_finite(value.q3);
}

bool is_finite(const Matrix3& value) {
  return is_finite(value.m11) && is_finite(value.m12) && is_finite(value.m13) &&
      is_finite(value.m21) && is_finite(value.m22) && is_finite(value.m23) &&
      is_finite(value.m31) && is_finite(value.m32) && is_finite(value.m33);
}

Vec3 read_vec3(const RBKVector3* value) {
  if (value == nullptr) {
    return {};
  }
  return {value->X(), value->Y(), value->Z()};
}

Quat read_quat(const RBKQuaternion* value) {
  if (value == nullptr) {
    return {};
  }
  return {value->Q0(), value->Q1(), value->Q2(), value->Q3()};
}

Matrix3 read_matrix(const RBKMatrix3* value) {
  if (value == nullptr) {
    return {};
  }
  return {
      value->M11(), value->M12(), value->M13(),
      value->M21(), value->M22(), value->M23(),
      value->M31(), value->M32(), value->M33()};
}

double dot(const Vec3& left, const Vec3& right) {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

double norm(const Vec3& value) {
  return std::sqrt(dot(value, value));
}

double safe_acos(double value) {
  if (value < -1.0) {
    return std::acos(-1.0);
  }
  if (value > 1.0) {
    return std::acos(1.0);
  }
  return std::acos(value);
}

double safe_asin(double value) {
  if (value < -1.0) {
    return std::asin(-1.0);
  }
  if (value > 1.0) {
    return std::asin(1.0);
  }
  return std::asin(value);
}

Vec3 add(const Vec3& left, const Vec3& right) {
  return {left.x + right.x, left.y + right.y, left.z + right.z};
}

Vec3 subtract(const Vec3& left, const Vec3& right) {
  return {left.x - right.x, left.y - right.y, left.z - right.z};
}

Vec3 scale(const Vec3& value, double factor) {
  return {value.x * factor, value.y * factor, value.z * factor};
}

Vec3 cross(const Vec3& left, const Vec3& right) {
  return {
      left.y * right.z - left.z * right.y,
      left.z * right.x - left.x * right.z,
      left.x * right.y - left.y * right.x};
}

bool tilde_matrix(const Vec3& input, Matrix3* output) {
  if (output == nullptr || !is_finite(input)) {
    return false;
  }
  *output = {
      0.0, -input.z, input.y,
      input.z, 0.0, -input.x,
      -input.y, input.x, 0.0};
  return true;
}

bool elementary_rotation_matrix(int axis, double angle_rad, Matrix3* output) {
  if (output == nullptr || !is_finite(angle_rad)) {
    return false;
  }
  const double c = std::cos(angle_rad);
  const double s = std::sin(angle_rad);
  switch (axis) {
    case 1:
      *output = {
          1.0, 0.0, 0.0,
          0.0, c, s,
          0.0, -s, c};
      return true;
    case 2:
      *output = {
          c, 0.0, -s,
          0.0, 1.0, 0.0,
          s, 0.0, c};
      return true;
    case 3:
      *output = {
          c, s, 0.0,
          -s, c, 0.0,
          0.0, 0.0, 1.0};
      return true;
    default:
      return false;
  }
}

bool mrp_shadow(const Vec3& input, Vec3* output) {
  const double norm_squared = dot(input, input);
  if (output == nullptr || !is_finite(input) || norm_squared <= kSingularTolerance) {
    return false;
  }
  *output = scale(input, -1.0 / norm_squared);
  return true;
}

bool add_mrp(const Vec3& left, const Vec3& right, Vec3* output) {
  if (output == nullptr || !is_finite(left) || !is_finite(right)) {
    return false;
  }

  Vec3 sigma_left = left;
  const double right_norm_squared = dot(right, right);
  double left_norm_squared = dot(sigma_left, sigma_left);
  double denominator = 1.0 + left_norm_squared * right_norm_squared - 2.0 * dot(sigma_left, right);

  if (std::fabs(denominator) < 0.1) {
    if (!mrp_shadow(sigma_left, &sigma_left)) {
      return false;
    }
    left_norm_squared = dot(sigma_left, sigma_left);
    denominator = 1.0 + left_norm_squared * right_norm_squared - 2.0 * dot(sigma_left, right);
  }
  if (std::fabs(denominator) <= kSingularTolerance) {
    return false;
  }

  const Vec3 cross_term = scale(cross(sigma_left, right), 2.0);
  Vec3 composed = add(
      add(scale(sigma_left, 1.0 - right_norm_squared), cross_term),
      scale(right, 1.0 - left_norm_squared));
  composed = scale(composed, 1.0 / denominator);

  if (dot(composed, composed) > 1.0 && !mrp_shadow(composed, &composed)) {
    return false;
  }
  *output = composed;
  return is_finite(*output);
}

bool sub_mrp(const Vec3& left, const Vec3& right, Vec3* output) {
  if (output == nullptr || !is_finite(left) || !is_finite(right)) {
    return false;
  }

  Vec3 sigma_left = left;
  const double right_norm_squared = dot(right, right);
  double left_norm_squared = dot(sigma_left, sigma_left);
  double denominator = 1.0 + left_norm_squared * right_norm_squared + 2.0 * dot(sigma_left, right);

  if (std::fabs(denominator) < 0.1) {
    if (!mrp_shadow(sigma_left, &sigma_left)) {
      return false;
    }
    left_norm_squared = dot(sigma_left, sigma_left);
    denominator = 1.0 + left_norm_squared * right_norm_squared + 2.0 * dot(sigma_left, right);
  }
  if (std::fabs(denominator) <= kSingularTolerance) {
    return false;
  }

  const Vec3 cross_term = scale(cross(sigma_left, right), 2.0);
  Vec3 relative = add(
      add(scale(sigma_left, 1.0 - right_norm_squared), cross_term),
      scale(right, -(1.0 - left_norm_squared)));
  relative = scale(relative, 1.0 / denominator);

  if (dot(relative, relative) > 1.0 && !mrp_shadow(relative, &relative)) {
    return false;
  }
  *output = relative;
  return is_finite(*output);
}

bool add_gibbs(const Vec3& left, const Vec3& right, Vec3* output) {
  if (output == nullptr || !is_finite(left) || !is_finite(right)) {
    return false;
  }
  const double denominator = 1.0 - dot(left, right);
  if (std::fabs(denominator) <= kSingularTolerance) {
    return false;
  }
  *output = scale(add(add(left, right), cross(left, right)), 1.0 / denominator);
  return is_finite(*output);
}

bool sub_gibbs(const Vec3& left, const Vec3& right, Vec3* output) {
  if (output == nullptr || !is_finite(left) || !is_finite(right)) {
    return false;
  }
  const double denominator = 1.0 + dot(left, right);
  if (std::fabs(denominator) <= kSingularTolerance) {
    return false;
  }
  *output = scale(subtract(add(left, cross(left, right)), right), 1.0 / denominator);
  return is_finite(*output);
}

void prv_to_element(const Vec3& input, double* angle, Vec3* axis) {
  const double input_norm = norm(input);
  if (angle != nullptr) {
    *angle = input_norm;
  }
  if (axis == nullptr) {
    return;
  }
  if (input_norm < kNearZero) {
    *axis = {};
    return;
  }
  *axis = scale(input, 1.0 / input_norm);
}

bool add_prv(const Vec3& left, const Vec3& right, Vec3* output) {
  if (output == nullptr || !is_finite(left) || !is_finite(right)) {
    return false;
  }
  if (norm(left) < 1.0e-7 || norm(right) < 1.0e-7) {
    *output = add(left, right);
    return is_finite(*output);
  }

  double left_angle = 0.0;
  double right_angle = 0.0;
  Vec3 left_axis;
  Vec3 right_axis;
  prv_to_element(left, &left_angle, &left_axis);
  prv_to_element(right, &right_angle, &right_axis);

  const double cp1 = std::cos(left_angle / 2.0);
  const double cp2 = std::cos(right_angle / 2.0);
  const double sp1 = std::sin(left_angle / 2.0);
  const double sp2 = std::sin(right_angle / 2.0);
  const double angle = 2.0 * safe_acos(cp1 * cp2 - sp1 * sp2 * dot(left_axis, right_axis));
  if (std::fabs(angle) < 1.0e-13) {
    *output = {};
    return true;
  }
  const double sp = std::sin(angle / 2.0);
  if (std::fabs(sp) <= kSingularTolerance) {
    return false;
  }

  Vec3 result = add(scale(right_axis, cp1 * sp2), scale(left_axis, cp2 * sp1));
  result = add(result, scale(cross(left_axis, right_axis), sp1 * sp2));
  *output = scale(result, angle / sp);
  return is_finite(*output);
}

bool sub_prv(const Vec3& left, const Vec3& right, Vec3* output) {
  if (output == nullptr || !is_finite(left) || !is_finite(right)) {
    return false;
  }

  double left_angle = 0.0;
  double right_angle = 0.0;
  Vec3 left_axis;
  Vec3 right_axis;
  prv_to_element(left, &left_angle, &left_axis);
  prv_to_element(right, &right_angle, &right_axis);

  const double cp1 = std::cos(left_angle / 2.0);
  const double cp2 = std::cos(right_angle / 2.0);
  const double sp1 = std::sin(left_angle / 2.0);
  const double sp2 = std::sin(right_angle / 2.0);
  const double angle = 2.0 * safe_acos(cp1 * cp2 + sp1 * sp2 * dot(left_axis, right_axis));
  const double sp = std::sin(angle / 2.0);
  if (std::fabs(sp) <= kSingularTolerance) {
    *output = {};
    return true;
  }

  Vec3 result = scale(cross(left_axis, right_axis), sp1 * sp2);
  result = add(result, scale(left_axis, cp2 * sp1));
  result = subtract(result, scale(right_axis, cp1 * sp2));
  *output = scale(result, angle / sp);
  return is_finite(*output);
}

bool mrp_switch(const Vec3& input, double threshold, Vec3* output) {
  if (output == nullptr || !is_finite(input) || !std::isfinite(threshold) || threshold < 0.0) {
    return false;
  }
  const double norm_squared = dot(input, input);
  if (norm_squared > threshold * threshold) {
    return mrp_shadow(input, output);
  }
  *output = input;
  return true;
}

bool mrp_to_ep(const Vec3& input, Quat* output) {
  if (output == nullptr || !is_finite(input)) {
    return false;
  }
  const double norm_squared = dot(input, input);
  const double denominator = 1.0 + norm_squared;
  if (std::fabs(denominator) <= kSingularTolerance) {
    return false;
  }
  *output = {
      (1.0 - norm_squared) / denominator,
      2.0 * input.x / denominator,
      2.0 * input.y / denominator,
      2.0 * input.z / denominator};
  return is_finite(*output);
}

bool ep_to_mrp(const Quat& input, Vec3* output) {
  if (output == nullptr || !is_finite(input)) {
    return false;
  }
  const double denominator = 1.0 + input.q0;
  if (std::fabs(denominator) <= kSingularTolerance) {
    return false;
  }
  *output = {input.q1 / denominator, input.q2 / denominator, input.q3 / denominator};
  return is_finite(*output);
}

bool ep_to_gibbs(const Quat& input, Vec3* output) {
  if (output == nullptr || !is_finite(input) || std::fabs(input.q0) <= kSingularTolerance) {
    return false;
  }
  *output = {input.q1 / input.q0, input.q2 / input.q0, input.q3 / input.q0};
  return is_finite(*output);
}

bool gibbs_to_ep(const Vec3& input, Quat* output) {
  if (output == nullptr || !is_finite(input)) {
    return false;
  }
  const double denominator = std::sqrt(1.0 + dot(input, input));
  if (std::fabs(denominator) <= kSingularTolerance) {
    return false;
  }
  const double scale_factor = 1.0 / denominator;
  *output = {scale_factor, input.x * scale_factor, input.y * scale_factor, input.z * scale_factor};
  return is_finite(*output);
}

bool ep_to_prv(const Quat& input, Vec3* output) {
  if (output == nullptr || !is_finite(input)) {
    return false;
  }
  const double angle = 2.0 * safe_acos(input.q0);
  const double sp = std::sin(angle / 2.0);
  if (std::fabs(sp) < kNearZero) {
    *output = {};
    return true;
  }
  *output = {input.q1 / sp * angle, input.q2 / sp * angle, input.q3 / sp * angle};
  return is_finite(*output);
}

bool prv_to_ep(const Vec3& input, Quat* output) {
  if (output == nullptr || !is_finite(input)) {
    return false;
  }
  double angle = 0.0;
  Vec3 axis;
  prv_to_element(input, &angle, &axis);
  const double sp = std::sin(angle / 2.0);
  *output = {std::cos(angle / 2.0), axis.x * sp, axis.y * sp, axis.z * sp};
  return is_finite(*output);
}

bool dcm_to_ep(const Matrix3& input, Quat* output) {
  if (output == nullptr || !is_finite(input)) {
    return false;
  }

  const double trace = input.m11 + input.m22 + input.m33;
  const double b2[4] = {
      (1.0 + trace) / 4.0,
      (1.0 + 2.0 * input.m11 - trace) / 4.0,
      (1.0 + 2.0 * input.m22 - trace) / 4.0,
      (1.0 + 2.0 * input.m33 - trace) / 4.0};

  int max_index = 0;
  double max_value = b2[0];
  for (int index = 1; index < 4; ++index) {
    if (b2[index] > max_value) {
      max_index = index;
      max_value = b2[index];
    }
  }
  if (max_value < -kSingularTolerance) {
    return false;
  }

  Quat result;
  switch (max_index) {
    case 0:
      result.q0 = std::sqrt(std::fmax(0.0, b2[0]));
      if (std::fabs(result.q0) <= kSingularTolerance) {
        return false;
      }
      result.q1 = (input.m23 - input.m32) / 4.0 / result.q0;
      result.q2 = (input.m31 - input.m13) / 4.0 / result.q0;
      result.q3 = (input.m12 - input.m21) / 4.0 / result.q0;
      break;
    case 1:
      result.q1 = std::sqrt(std::fmax(0.0, b2[1]));
      if (std::fabs(result.q1) <= kSingularTolerance) {
        return false;
      }
      result.q0 = (input.m23 - input.m32) / 4.0 / result.q1;
      if (result.q0 < 0.0) {
        result.q1 = -result.q1;
        result.q0 = -result.q0;
      }
      result.q2 = (input.m12 + input.m21) / 4.0 / result.q1;
      result.q3 = (input.m31 + input.m13) / 4.0 / result.q1;
      break;
    case 2:
      result.q2 = std::sqrt(std::fmax(0.0, b2[2]));
      if (std::fabs(result.q2) <= kSingularTolerance) {
        return false;
      }
      result.q0 = (input.m31 - input.m13) / 4.0 / result.q2;
      if (result.q0 < 0.0) {
        result.q2 = -result.q2;
        result.q0 = -result.q0;
      }
      result.q1 = (input.m12 + input.m21) / 4.0 / result.q2;
      result.q3 = (input.m23 + input.m32) / 4.0 / result.q2;
      break;
    case 3:
      result.q3 = std::sqrt(std::fmax(0.0, b2[3]));
      if (std::fabs(result.q3) <= kSingularTolerance) {
        return false;
      }
      result.q0 = (input.m12 - input.m21) / 4.0 / result.q3;
      if (result.q0 < 0.0) {
        result.q3 = -result.q3;
        result.q0 = -result.q0;
      }
      result.q1 = (input.m31 + input.m13) / 4.0 / result.q3;
      result.q2 = (input.m23 + input.m32) / 4.0 / result.q3;
      break;
  }

  *output = result;
  return is_finite(*output);
}

bool ep_to_dcm(const Quat& input, Matrix3* output) {
  if (output == nullptr || !is_finite(input)) {
    return false;
  }
  const double q0 = input.q0;
  const double q1 = input.q1;
  const double q2 = input.q2;
  const double q3 = input.q3;
  *output = {
      q0 * q0 + q1 * q1 - q2 * q2 - q3 * q3,
      2.0 * (q1 * q2 + q0 * q3),
      2.0 * (q1 * q3 - q0 * q2),
      2.0 * (q1 * q2 - q0 * q3),
      q0 * q0 - q1 * q1 + q2 * q2 - q3 * q3,
      2.0 * (q2 * q3 + q0 * q1),
      2.0 * (q1 * q3 + q0 * q2),
      2.0 * (q2 * q3 - q0 * q1),
      q0 * q0 - q1 * q1 - q2 * q2 + q3 * q3};
  return is_finite(*output);
}

bool dcm_to_mrp(const Matrix3& input, Vec3* output) {
  Quat ep;
  return dcm_to_ep(input, &ep) && ep_to_mrp(ep, output);
}

bool dcm_to_gibbs(const Matrix3& input, Vec3* output) {
  Quat ep;
  return dcm_to_ep(input, &ep) && ep_to_gibbs(ep, output);
}

bool dcm_to_prv(const Matrix3& input, Vec3* output) {
  Quat ep;
  return dcm_to_ep(input, &ep) && ep_to_prv(ep, output);
}

bool mrp_to_dcm(const Vec3& input, Matrix3* output) {
  if (output == nullptr || !is_finite(input)) {
    return false;
  }
  const double q1 = input.x;
  const double q2 = input.y;
  const double q3 = input.z;
  const double q_norm_squared = dot(input, input);
  const double s = 1.0 - q_norm_squared;
  const double denominator = (1.0 + q_norm_squared) * (1.0 + q_norm_squared);
  if (std::fabs(denominator) <= kSingularTolerance) {
    return false;
  }

  *output = {
      (4.0 * (2.0 * q1 * q1 - q_norm_squared) + s * s) / denominator,
      (8.0 * q1 * q2 + 4.0 * q3 * s) / denominator,
      (8.0 * q1 * q3 - 4.0 * q2 * s) / denominator,
      (8.0 * q2 * q1 - 4.0 * q3 * s) / denominator,
      (4.0 * (2.0 * q2 * q2 - q_norm_squared) + s * s) / denominator,
      (8.0 * q2 * q3 + 4.0 * q1 * s) / denominator,
      (8.0 * q3 * q1 + 4.0 * q2 * s) / denominator,
      (8.0 * q3 * q2 - 4.0 * q1 * s) / denominator,
      (4.0 * (2.0 * q3 * q3 - q_norm_squared) + s * s) / denominator};
  return is_finite(*output);
}

bool prv_to_dcm(const Vec3& input, Matrix3* output) {
  if (output == nullptr || !is_finite(input)) {
    return false;
  }
  const double angle = norm(input);
  if (angle == 0.0) {
    *output = {1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0};
    return true;
  }
  const Vec3 axis = scale(input, 1.0 / angle);
  const double cp = std::cos(angle);
  const double sp = std::sin(angle);
  const double d1 = 1.0 - cp;
  *output = {
      axis.x * axis.x * d1 + cp,
      axis.x * axis.y * d1 + axis.z * sp,
      axis.x * axis.z * d1 - axis.y * sp,
      axis.y * axis.x * d1 - axis.z * sp,
      axis.y * axis.y * d1 + cp,
      axis.y * axis.z * d1 + axis.x * sp,
      axis.z * axis.x * d1 + axis.y * sp,
      axis.z * axis.y * d1 - axis.x * sp,
      axis.z * axis.z * d1 + cp};
  return is_finite(*output);
}

bool gibbs_to_dcm(const Vec3& input, Matrix3* output) {
  if (output == nullptr || !is_finite(input)) {
    return false;
  }
  const double q1 = input.x;
  const double q2 = input.y;
  const double q3 = input.z;
  const double q_norm_squared = dot(input, input);
  const double scale_factor = 1.0 / (1.0 + q_norm_squared);
  *output = {
      (1.0 + 2.0 * q1 * q1 - q_norm_squared) * scale_factor,
      2.0 * (q1 * q2 + q3) * scale_factor,
      2.0 * (q1 * q3 - q2) * scale_factor,
      2.0 * (q2 * q1 - q3) * scale_factor,
      (1.0 + 2.0 * q2 * q2 - q_norm_squared) * scale_factor,
      2.0 * (q2 * q3 + q1) * scale_factor,
      2.0 * (q3 * q1 + q2) * scale_factor,
      2.0 * (q3 * q2 - q1) * scale_factor,
      (1.0 + 2.0 * q3 * q3 - q_norm_squared) * scale_factor};
  return is_finite(*output);
}

bool is_euler_sequence(rbkEulerSequenceCode sequence) {
  switch (sequence) {
    case rbkEulerSequenceCode_EULER_121:
    case rbkEulerSequenceCode_EULER_123:
    case rbkEulerSequenceCode_EULER_131:
    case rbkEulerSequenceCode_EULER_132:
    case rbkEulerSequenceCode_EULER_212:
    case rbkEulerSequenceCode_EULER_213:
    case rbkEulerSequenceCode_EULER_231:
    case rbkEulerSequenceCode_EULER_232:
    case rbkEulerSequenceCode_EULER_312:
    case rbkEulerSequenceCode_EULER_313:
    case rbkEulerSequenceCode_EULER_321:
    case rbkEulerSequenceCode_EULER_323:
      return true;
    case rbkEulerSequenceCode_UNKNOWN:
    default:
      return false;
  }
}

bool is_repeated_euler_sequence(rbkEulerSequenceCode sequence) {
  switch (sequence) {
    case rbkEulerSequenceCode_EULER_121:
    case rbkEulerSequenceCode_EULER_131:
    case rbkEulerSequenceCode_EULER_212:
    case rbkEulerSequenceCode_EULER_232:
    case rbkEulerSequenceCode_EULER_313:
    case rbkEulerSequenceCode_EULER_323:
      return true;
    case rbkEulerSequenceCode_EULER_123:
    case rbkEulerSequenceCode_EULER_132:
    case rbkEulerSequenceCode_EULER_213:
    case rbkEulerSequenceCode_EULER_231:
    case rbkEulerSequenceCode_EULER_312:
    case rbkEulerSequenceCode_EULER_321:
    case rbkEulerSequenceCode_UNKNOWN:
    default:
      return false;
  }
}

double wrap_to_pi(double angle) {
  if (angle > std::acos(-1.0)) {
    return angle - 2.0 * std::acos(-1.0);
  }
  if (angle < -std::acos(-1.0)) {
    return angle + 2.0 * std::acos(-1.0);
  }
  return angle;
}

Matrix3 scale_matrix(const Matrix3& matrix, double factor) {
  return {
      matrix.m11 * factor, matrix.m12 * factor, matrix.m13 * factor,
      matrix.m21 * factor, matrix.m22 * factor, matrix.m23 * factor,
      matrix.m31 * factor, matrix.m32 * factor, matrix.m33 * factor};
}

Matrix3 multiply_matrices(const Matrix3& left, const Matrix3& right) {
  return {
      left.m11 * right.m11 + left.m12 * right.m21 + left.m13 * right.m31,
      left.m11 * right.m12 + left.m12 * right.m22 + left.m13 * right.m32,
      left.m11 * right.m13 + left.m12 * right.m23 + left.m13 * right.m33,
      left.m21 * right.m11 + left.m22 * right.m21 + left.m23 * right.m31,
      left.m21 * right.m12 + left.m22 * right.m22 + left.m23 * right.m32,
      left.m21 * right.m13 + left.m22 * right.m23 + left.m23 * right.m33,
      left.m31 * right.m11 + left.m32 * right.m21 + left.m33 * right.m31,
      left.m31 * right.m12 + left.m32 * right.m22 + left.m33 * right.m32,
      left.m31 * right.m13 + left.m32 * right.m23 + left.m33 * right.m33};
}

Matrix3 transpose_matrix(const Matrix3& matrix) {
  return {
      matrix.m11, matrix.m21, matrix.m31,
      matrix.m12, matrix.m22, matrix.m32,
      matrix.m13, matrix.m23, matrix.m33};
}

bool euler_to_dcm(rbkEulerSequenceCode sequence, const Vec3& input, Matrix3* output) {
  if (output == nullptr || !is_finite(input) || !is_euler_sequence(sequence)) {
    return false;
  }
  const double st1 = std::sin(input.x);
  const double ct1 = std::cos(input.x);
  const double st2 = std::sin(input.y);
  const double ct2 = std::cos(input.y);
  const double st3 = std::sin(input.z);
  const double ct3 = std::cos(input.z);

  switch (sequence) {
    case rbkEulerSequenceCode_EULER_121:
      *output = {
          ct2, st1 * st2, -ct1 * st2,
          st2 * st3, ct1 * ct3 - ct2 * st1 * st3, ct3 * st1 + ct1 * ct2 * st3,
          ct3 * st2, -ct2 * ct3 * st1 - ct1 * st3, ct1 * ct2 * ct3 - st1 * st3};
      break;
    case rbkEulerSequenceCode_EULER_123:
      *output = {
          ct2 * ct3, ct3 * st1 * st2 + ct1 * st3, st1 * st3 - ct1 * ct3 * st2,
          -ct2 * st3, ct1 * ct3 - st1 * st2 * st3, ct3 * st1 + ct1 * st2 * st3,
          st2, -ct2 * st1, ct1 * ct2};
      break;
    case rbkEulerSequenceCode_EULER_131:
      *output = {
          ct2, ct1 * st2, st1 * st2,
          -ct3 * st2, ct1 * ct2 * ct3 - st1 * st3, ct2 * ct3 * st1 + ct1 * st3,
          st2 * st3, -ct3 * st1 - ct1 * ct2 * st3, ct1 * ct3 - ct2 * st1 * st3};
      break;
    case rbkEulerSequenceCode_EULER_132:
      *output = {
          ct2 * ct3, ct1 * ct3 * st2 + st1 * st3, ct3 * st1 * st2 - ct1 * st3,
          -st2, ct1 * ct2, ct2 * st1,
          ct2 * st3, -ct3 * st1 + ct1 * st2 * st3, ct1 * ct3 + st1 * st2 * st3};
      break;
    case rbkEulerSequenceCode_EULER_212:
      *output = {
          ct1 * ct3 - ct2 * st1 * st3, st2 * st3, -ct3 * st1 - ct1 * ct2 * st3,
          st1 * st2, ct2, ct1 * st2,
          ct2 * ct3 * st1 + ct1 * st3, -ct3 * st2, ct1 * ct2 * ct3 - st1 * st3};
      break;
    case rbkEulerSequenceCode_EULER_213:
      *output = {
          ct1 * ct3 + st1 * st2 * st3, ct2 * st3, -ct3 * st1 + ct1 * st2 * st3,
          ct3 * st1 * st2 - ct1 * st3, ct2 * ct3, ct1 * ct3 * st2 + st1 * st3,
          ct2 * st1, -st2, ct1 * ct2};
      break;
    case rbkEulerSequenceCode_EULER_231:
      *output = {
          ct1 * ct2, st2, -ct2 * st1,
          -ct1 * ct3 * st2 + st1 * st3, ct2 * ct3, ct3 * st1 * st2 + ct1 * st3,
          ct3 * st1 + ct1 * st2 * st3, -ct2 * st3, ct1 * ct3 - st1 * st2 * st3};
      break;
    case rbkEulerSequenceCode_EULER_232:
      *output = {
          ct1 * ct2 * ct3 - st1 * st3, ct3 * st2, -ct2 * ct3 * st1 - ct1 * st3,
          -ct1 * st2, ct2, st1 * st2,
          ct3 * st1 + ct1 * ct2 * st3, st2 * st3, ct1 * ct3 - ct2 * st1 * st3};
      break;
    case rbkEulerSequenceCode_EULER_312:
      *output = {
          ct1 * ct3 - st1 * st2 * st3, ct3 * st1 + ct1 * st2 * st3, -ct2 * st3,
          -ct2 * st1, ct1 * ct2, st2,
          ct3 * st1 * st2 + ct1 * st3, st1 * st3 - ct1 * ct3 * st2, ct2 * ct3};
      break;
    case rbkEulerSequenceCode_EULER_313:
      *output = {
          ct3 * ct1 - st3 * ct2 * st1, ct3 * st1 + st3 * ct2 * ct1, st3 * st2,
          -st3 * ct1 - ct3 * ct2 * st1, -st3 * st1 + ct3 * ct2 * ct1, ct3 * st2,
          st2 * st1, -st2 * ct1, ct2};
      break;
    case rbkEulerSequenceCode_EULER_321:
      *output = {
          ct2 * ct1, ct2 * st1, -st2,
          st3 * st2 * ct1 - ct3 * st1, st3 * st2 * st1 + ct3 * ct1, st3 * ct2,
          ct3 * st2 * ct1 + st3 * st1, ct3 * st2 * st1 - st3 * ct1, ct3 * ct2};
      break;
    case rbkEulerSequenceCode_EULER_323:
      *output = {
          ct1 * ct2 * ct3 - st1 * st3, ct2 * ct3 * st1 + ct1 * st3, -ct3 * st2,
          -ct3 * st1 - ct1 * ct2 * st3, ct1 * ct3 - ct2 * st1 * st3, st2 * st3,
          ct1 * st2, st1 * st2, ct2};
      break;
    case rbkEulerSequenceCode_UNKNOWN:
    default:
      return false;
  }
  return is_finite(*output);
}

bool dcm_to_euler(rbkEulerSequenceCode sequence, const Matrix3& input, Vec3* output) {
  if (output == nullptr || !is_finite(input) || !is_euler_sequence(sequence)) {
    return false;
  }
  switch (sequence) {
    case rbkEulerSequenceCode_EULER_121:
      *output = {std::atan2(input.m12, -input.m13), safe_acos(input.m11), std::atan2(input.m21, input.m31)};
      break;
    case rbkEulerSequenceCode_EULER_123:
      *output = {std::atan2(-input.m32, input.m33), safe_asin(input.m31), std::atan2(-input.m21, input.m11)};
      break;
    case rbkEulerSequenceCode_EULER_131:
      *output = {std::atan2(input.m13, input.m12), safe_acos(input.m11), std::atan2(input.m31, -input.m21)};
      break;
    case rbkEulerSequenceCode_EULER_132:
      *output = {std::atan2(input.m23, input.m22), safe_asin(-input.m21), std::atan2(input.m31, input.m11)};
      break;
    case rbkEulerSequenceCode_EULER_212:
      *output = {std::atan2(input.m21, input.m23), safe_acos(input.m22), std::atan2(input.m12, -input.m32)};
      break;
    case rbkEulerSequenceCode_EULER_213:
      *output = {std::atan2(input.m31, input.m33), safe_asin(-input.m32), std::atan2(input.m12, input.m22)};
      break;
    case rbkEulerSequenceCode_EULER_231:
      *output = {std::atan2(-input.m13, input.m11), safe_asin(input.m12), std::atan2(-input.m32, input.m22)};
      break;
    case rbkEulerSequenceCode_EULER_232:
      *output = {std::atan2(input.m23, -input.m21), safe_acos(input.m22), std::atan2(input.m32, input.m12)};
      break;
    case rbkEulerSequenceCode_EULER_312:
      *output = {std::atan2(-input.m21, input.m22), safe_asin(input.m23), std::atan2(-input.m13, input.m33)};
      break;
    case rbkEulerSequenceCode_EULER_313:
      *output = {std::atan2(input.m31, -input.m32), safe_acos(input.m33), std::atan2(input.m13, input.m23)};
      break;
    case rbkEulerSequenceCode_EULER_321:
      *output = {std::atan2(input.m12, input.m11), safe_asin(-input.m13), std::atan2(input.m23, input.m33)};
      break;
    case rbkEulerSequenceCode_EULER_323:
      *output = {std::atan2(input.m32, input.m31), safe_acos(input.m33), std::atan2(input.m23, -input.m13)};
      break;
    case rbkEulerSequenceCode_UNKNOWN:
    default:
      return false;
  }
  return is_finite(*output);
}

bool add_repeated_euler(const Vec3& left, const Vec3& right, Vec3* output) {
  if (output == nullptr || !is_finite(left) || !is_finite(right)) {
    return false;
  }
  const double cp1 = std::cos(left.y);
  const double cp2 = std::cos(right.y);
  const double sp1 = std::sin(left.y);
  const double sp2 = std::sin(right.y);
  const double dum = left.z + right.x;
  const double angle2 = safe_acos(cp1 * cp2 - sp1 * sp2 * std::cos(dum));
  const double cp3 = std::cos(angle2);
  *output = {
      wrap_to_pi(left.x + std::atan2(sp1 * sp2 * std::sin(dum), cp2 - cp3 * cp1)),
      angle2,
      wrap_to_pi(right.z + std::atan2(sp1 * sp2 * std::sin(dum), cp1 - cp3 * cp2))};
  return is_finite(*output);
}

bool sub_repeated_euler(const Vec3& left, const Vec3& right, Vec3* output) {
  if (output == nullptr || !is_finite(left) || !is_finite(right)) {
    return false;
  }
  const double cp = std::cos(left.y);
  const double cp1 = std::cos(right.y);
  const double sp = std::sin(left.y);
  const double sp1 = std::sin(right.y);
  const double dum = left.x - right.x;
  const double angle2 = safe_acos(cp1 * cp + sp1 * sp * std::cos(dum));
  const double cp2 = std::cos(angle2);
  *output = {
      wrap_to_pi(-right.z + std::atan2(sp1 * sp * std::sin(dum), cp2 * cp1 - cp)),
      angle2,
      wrap_to_pi(left.z - std::atan2(sp1 * sp * std::sin(dum), cp1 - cp * cp2))};
  return is_finite(*output);
}

bool add_euler(rbkEulerSequenceCode sequence, const Vec3& left, const Vec3& right, Vec3* output) {
  if (is_repeated_euler_sequence(sequence)) {
    return add_repeated_euler(left, right, output);
  }
  Matrix3 left_matrix;
  Matrix3 right_matrix;
  if (output == nullptr || !euler_to_dcm(sequence, left, &left_matrix) || !euler_to_dcm(sequence, right, &right_matrix)) {
    return false;
  }
  return dcm_to_euler(sequence, multiply_matrices(right_matrix, left_matrix), output);
}

bool sub_euler(rbkEulerSequenceCode sequence, const Vec3& left, const Vec3& right, Vec3* output) {
  if (is_repeated_euler_sequence(sequence)) {
    return sub_repeated_euler(left, right, output);
  }
  Matrix3 left_matrix;
  Matrix3 right_matrix;
  if (output == nullptr || !euler_to_dcm(sequence, left, &left_matrix) || !euler_to_dcm(sequence, right, &right_matrix)) {
    return false;
  }
  return dcm_to_euler(sequence, multiply_matrices(left_matrix, transpose_matrix(right_matrix)), output);
}

bool euler_to_ep(rbkEulerSequenceCode sequence, const Vec3& input, Quat* output) {
  Matrix3 matrix;
  return euler_to_dcm(sequence, input, &matrix) && dcm_to_ep(matrix, output);
}

bool euler_to_mrp(rbkEulerSequenceCode sequence, const Vec3& input, Vec3* output) {
  Matrix3 matrix;
  return euler_to_dcm(sequence, input, &matrix) && dcm_to_mrp(matrix, output);
}

bool euler_to_gibbs(rbkEulerSequenceCode sequence, const Vec3& input, Vec3* output) {
  Matrix3 matrix;
  return euler_to_dcm(sequence, input, &matrix) && dcm_to_gibbs(matrix, output);
}

bool euler_to_prv(rbkEulerSequenceCode sequence, const Vec3& input, Vec3* output) {
  Matrix3 matrix;
  return euler_to_dcm(sequence, input, &matrix) && dcm_to_prv(matrix, output);
}

bool ep_to_euler(rbkEulerSequenceCode sequence, const Quat& input, Vec3* output) {
  Matrix3 matrix;
  return ep_to_dcm(input, &matrix) && dcm_to_euler(sequence, matrix, output);
}

bool mrp_to_euler(rbkEulerSequenceCode sequence, const Vec3& input, Vec3* output) {
  Matrix3 matrix;
  return mrp_to_dcm(input, &matrix) && dcm_to_euler(sequence, matrix, output);
}

bool gibbs_to_euler(rbkEulerSequenceCode sequence, const Vec3& input, Vec3* output) {
  Matrix3 matrix;
  return gibbs_to_dcm(input, &matrix) && dcm_to_euler(sequence, matrix, output);
}

bool prv_to_euler(rbkEulerSequenceCode sequence, const Vec3& input, Vec3* output) {
  Matrix3 matrix;
  return prv_to_dcm(input, &matrix) && dcm_to_euler(sequence, matrix, output);
}

bool b_matrix_euler(rbkEulerSequenceCode sequence, const Vec3& input, Matrix3* output) {
  if (output == nullptr || !is_finite(input) || !is_euler_sequence(sequence)) {
    return false;
  }
  const double s2 = std::sin(input.y);
  const double c2 = std::cos(input.y);
  const double s3 = std::sin(input.z);
  const double c3 = std::cos(input.z);
  double scale_factor = 0.0;

  switch (sequence) {
    case rbkEulerSequenceCode_EULER_121:
      if (std::fabs(s2) <= kSingularTolerance) return false;
      *output = {0.0, s3, c3, 0.0, s2 * c3, -s2 * s3, s2, -c2 * s3, -c2 * c3};
      scale_factor = 1.0 / s2;
      break;
    case rbkEulerSequenceCode_EULER_123:
      if (std::fabs(c2) <= kSingularTolerance) return false;
      *output = {c3, -s3, 0.0, c2 * s3, c2 * c3, 0.0, -s2 * c3, s2 * s3, c2};
      scale_factor = 1.0 / c2;
      break;
    case rbkEulerSequenceCode_EULER_131:
      if (std::fabs(s2) <= kSingularTolerance) return false;
      *output = {0.0, -c3, s3, 0.0, s2 * s3, s2 * c3, s2, c2 * c3, -c2 * s3};
      scale_factor = 1.0 / s2;
      break;
    case rbkEulerSequenceCode_EULER_132:
      if (std::fabs(c2) <= kSingularTolerance) return false;
      *output = {c3, 0.0, s3, -c2 * s3, 0.0, c2 * c3, s2 * c3, c2, s2 * s3};
      scale_factor = 1.0 / c2;
      break;
    case rbkEulerSequenceCode_EULER_212:
      if (std::fabs(s2) <= kSingularTolerance) return false;
      *output = {s3, 0.0, -c3, s2 * c3, 0.0, s2 * s3, -c2 * s3, s2, c2 * c3};
      scale_factor = 1.0 / s2;
      break;
    case rbkEulerSequenceCode_EULER_213:
      if (std::fabs(c2) <= kSingularTolerance) return false;
      *output = {s3, c3, 0.0, c2 * c3, -c2 * s3, 0.0, s2 * s3, s2 * c3, c2};
      scale_factor = 1.0 / c2;
      break;
    case rbkEulerSequenceCode_EULER_231:
      if (std::fabs(c2) <= kSingularTolerance) return false;
      *output = {0.0, c3, -s3, 0.0, c2 * s3, c2 * c3, c2, -s2 * c3, s2 * s3};
      scale_factor = 1.0 / c2;
      break;
    case rbkEulerSequenceCode_EULER_232:
      if (std::fabs(s2) <= kSingularTolerance) return false;
      *output = {c3, 0.0, s3, -s2 * s3, 0.0, s2 * c3, -c2 * c3, s2, -c2 * s3};
      scale_factor = 1.0 / s2;
      break;
    case rbkEulerSequenceCode_EULER_312:
      if (std::fabs(c2) <= kSingularTolerance) return false;
      *output = {-s3, 0.0, c3, c2 * c3, 0.0, c2 * s3, s2 * s3, c2, -s2 * c3};
      scale_factor = 1.0 / c2;
      break;
    case rbkEulerSequenceCode_EULER_313:
      if (std::fabs(s2) <= kSingularTolerance) return false;
      *output = {s3, c3, 0.0, c3 * s2, -s3 * s2, 0.0, -s3 * c2, -c3 * c2, s2};
      scale_factor = 1.0 / s2;
      break;
    case rbkEulerSequenceCode_EULER_321:
      if (std::fabs(c2) <= kSingularTolerance) return false;
      *output = {0.0, s3, c3, 0.0, c2 * c3, -c2 * s3, c2, s2 * s3, s2 * c3};
      scale_factor = 1.0 / c2;
      break;
    case rbkEulerSequenceCode_EULER_323:
      if (std::fabs(s2) <= kSingularTolerance) return false;
      *output = {-c3, s3, 0.0, s2 * s3, s2 * c3, 0.0, c2 * c3, -c2 * s3, s2};
      scale_factor = 1.0 / s2;
      break;
    case rbkEulerSequenceCode_UNKNOWN:
    default:
      return false;
  }
  *output = scale_matrix(*output, scale_factor);
  return is_finite(*output);
}

bool b_inv_matrix_euler(rbkEulerSequenceCode sequence, const Vec3& input, Matrix3* output) {
  if (output == nullptr || !is_finite(input) || !is_euler_sequence(sequence)) {
    return false;
  }
  const double s2 = std::sin(input.y);
  const double c2 = std::cos(input.y);
  const double s3 = std::sin(input.z);
  const double c3 = std::cos(input.z);

  switch (sequence) {
    case rbkEulerSequenceCode_EULER_121:
      *output = {c2, 0.0, 1.0, s2 * s3, c3, 0.0, s2 * c3, -s3, 0.0};
      break;
    case rbkEulerSequenceCode_EULER_123:
      *output = {c2 * c3, s3, 0.0, -c2 * s3, c3, 0.0, s2, 0.0, 1.0};
      break;
    case rbkEulerSequenceCode_EULER_131:
      *output = {c2, 0.0, 1.0, -s2 * c3, s3, 0.0, s2 * s3, c3, 0.0};
      break;
    case rbkEulerSequenceCode_EULER_132:
      *output = {c2 * c3, -s3, 0.0, -s2, 0.0, 1.0, c2 * s3, c3, 0.0};
      break;
    case rbkEulerSequenceCode_EULER_212:
      *output = {s2 * s3, c3, 0.0, c2, 0.0, 1.0, -s2 * c3, s3, 0.0};
      break;
    case rbkEulerSequenceCode_EULER_213:
      *output = {c2 * s3, c3, 0.0, c2 * c3, -s3, 0.0, -s2, 0.0, 1.0};
      break;
    case rbkEulerSequenceCode_EULER_231:
      *output = {s2, 0.0, 1.0, c2 * c3, s3, 0.0, -c2 * s3, c3, 0.0};
      break;
    case rbkEulerSequenceCode_EULER_232:
      *output = {s2 * c3, -s3, 0.0, c2, 0.0, 1.0, s2 * s3, c3, 0.0};
      break;
    case rbkEulerSequenceCode_EULER_312:
      *output = {-c2 * s3, c3, 0.0, s2, 0.0, 1.0, c2 * c3, s3, 0.0};
      break;
    case rbkEulerSequenceCode_EULER_313:
      *output = {s2 * s3, c3, 0.0, s2 * c3, -s3, 0.0, c2, 0.0, 1.0};
      break;
    case rbkEulerSequenceCode_EULER_321:
      *output = {-s2, 0.0, 1.0, c2 * s3, c3, 0.0, c2 * c3, -s3, 0.0};
      break;
    case rbkEulerSequenceCode_EULER_323:
      *output = {-s2 * c3, s3, 0.0, s2 * s3, c3, 0.0, c2, 0.0, 1.0};
      break;
    case rbkEulerSequenceCode_UNKNOWN:
    default:
      return false;
  }
  return is_finite(*output);
}

bool d_euler(rbkEulerSequenceCode sequence, const Vec3& euler, const Vec3& body_rate, Vec3* output) {
  if (output == nullptr || !is_finite(body_rate)) {
    return false;
  }
  Matrix3 b_matrix;
  if (!b_matrix_euler(sequence, euler, &b_matrix)) {
    return false;
  }
  *output = {
      b_matrix.m11 * body_rate.x + b_matrix.m12 * body_rate.y + b_matrix.m13 * body_rate.z,
      b_matrix.m21 * body_rate.x + b_matrix.m22 * body_rate.y + b_matrix.m23 * body_rate.z,
      b_matrix.m31 * body_rate.x + b_matrix.m32 * body_rate.y + b_matrix.m33 * body_rate.z};
  return is_finite(*output);
}

bool mrp_to_gibbs(const Vec3& input, Vec3* output) {
  if (output == nullptr || !is_finite(input)) {
    return false;
  }
  const double denominator = 1.0 - dot(input, input);
  if (std::fabs(denominator) <= kSingularTolerance) {
    return false;
  }
  *output = scale(input, 2.0 / denominator);
  return is_finite(*output);
}

bool gibbs_to_mrp(const Vec3& input, Vec3* output) {
  if (output == nullptr || !is_finite(input)) {
    return false;
  }
  const double denominator = 1.0 + std::sqrt(1.0 + dot(input, input));
  if (std::fabs(denominator) <= kSingularTolerance) {
    return false;
  }
  *output = scale(input, 1.0 / denominator);
  return is_finite(*output);
}

bool mrp_to_prv(const Vec3& input, Vec3* output) {
  if (output == nullptr || !is_finite(input)) {
    return false;
  }
  const double tp = norm(input);
  if (tp < kNearZero) {
    *output = {};
    return true;
  }
  const double angle = 4.0 * std::atan(tp);
  *output = scale(input, angle / tp);
  return is_finite(*output);
}

bool prv_to_mrp(const Vec3& input, Vec3* output) {
  if (output == nullptr || !is_finite(input)) {
    return false;
  }
  double angle = 0.0;
  Vec3 axis;
  prv_to_element(input, &angle, &axis);
  *output = scale(axis, std::tan(angle / 4.0));
  return is_finite(*output);
}

bool gibbs_to_prv(const Vec3& input, Vec3* output) {
  if (output == nullptr || !is_finite(input)) {
    return false;
  }
  const double tp = norm(input);
  const double angle = 2.0 * std::atan(tp);
  if (tp < kNearZero) {
    *output = {};
    return true;
  }
  *output = scale(input, angle / tp);
  return is_finite(*output);
}

bool prv_to_gibbs(const Vec3& input, Vec3* output) {
  if (output == nullptr || !is_finite(input)) {
    return false;
  }
  double angle = 0.0;
  Vec3 axis;
  prv_to_element(input, &angle, &axis);
  *output = scale(axis, std::tan(angle / 2.0));
  return is_finite(*output);
}

bool b_matrix_mrp(const Vec3& input, Matrix3* output) {
  if (output == nullptr || !is_finite(input)) {
    return false;
  }
  const double q1 = input.x;
  const double q2 = input.y;
  const double q3 = input.z;
  const double q_norm_squared = dot(input, input);
  *output = {
      1.0 - q_norm_squared + 2.0 * q1 * q1,
      2.0 * (q1 * q2 - q3),
      2.0 * (q1 * q3 + q2),
      2.0 * (q2 * q1 + q3),
      1.0 - q_norm_squared + 2.0 * q2 * q2,
      2.0 * (q2 * q3 - q1),
      2.0 * (q3 * q1 - q2),
      2.0 * (q3 * q2 + q1),
      1.0 - q_norm_squared + 2.0 * q3 * q3};
  return is_finite(*output);
}

bool b_matrix_gibbs(const Vec3& input, Matrix3* output) {
  if (output == nullptr || !is_finite(input)) {
    return false;
  }
  const double q1 = input.x;
  const double q2 = input.y;
  const double q3 = input.z;
  *output = {
      1.0 + q1 * q1,
      q1 * q2 - q3,
      q1 * q3 + q2,
      q2 * q1 + q3,
      1.0 + q2 * q2,
      q2 * q3 - q1,
      q3 * q1 - q2,
      q3 * q2 + q1,
      1.0 + q3 * q3};
  return is_finite(*output);
}

bool b_matrix_prv(const Vec3& input, Matrix3* output) {
  if (output == nullptr || !is_finite(input)) {
    return false;
  }
  const double p = norm(input);
  if (p < kNearZero) {
    *output = {1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0};
    return true;
  }
  const double c = (1.0 - p / 2.0 / std::tan(p / 2.0)) / (p * p);
  *output = {
      1.0 - c * (input.y * input.y + input.z * input.z),
      -input.z / 2.0 + c * input.x * input.y,
      input.y / 2.0 + c * input.x * input.z,
      input.z / 2.0 + c * input.x * input.y,
      1.0 - c * (input.x * input.x + input.z * input.z),
      -input.x / 2.0 + c * input.y * input.z,
      -input.y / 2.0 + c * input.x * input.z,
      input.x / 2.0 + c * input.y * input.z,
      1.0 - c * (input.x * input.x + input.y * input.y)};
  return is_finite(*output);
}

bool b_inv_matrix_mrp(const Vec3& input, Matrix3* output) {
  if (output == nullptr || !is_finite(input)) {
    return false;
  }
  const double q1 = input.x;
  const double q2 = input.y;
  const double q3 = input.z;
  const double q_norm_squared = dot(input, input);
  *output = {
      1.0 - q_norm_squared + 2.0 * q1 * q1,
      2.0 * (q1 * q2 + q3),
      2.0 * (q1 * q3 - q2),
      2.0 * (q2 * q1 - q3),
      1.0 - q_norm_squared + 2.0 * q2 * q2,
      2.0 * (q2 * q3 + q1),
      2.0 * (q3 * q1 + q2),
      2.0 * (q3 * q2 - q1),
      1.0 - q_norm_squared + 2.0 * q3 * q3};
  const double scale_factor = 1.0 / ((1.0 + q_norm_squared) * (1.0 + q_norm_squared));
  *output = {
      output->m11 * scale_factor,
      output->m12 * scale_factor,
      output->m13 * scale_factor,
      output->m21 * scale_factor,
      output->m22 * scale_factor,
      output->m23 * scale_factor,
      output->m31 * scale_factor,
      output->m32 * scale_factor,
      output->m33 * scale_factor};
  return is_finite(*output);
}

bool b_inv_matrix_gibbs(const Vec3& input, Matrix3* output) {
  if (output == nullptr || !is_finite(input)) {
    return false;
  }
  const double scale_factor = 1.0 / (1.0 + dot(input, input));
  *output = {
      scale_factor,
      input.z * scale_factor,
      -input.y * scale_factor,
      -input.z * scale_factor,
      scale_factor,
      input.x * scale_factor,
      input.y * scale_factor,
      -input.x * scale_factor,
      scale_factor};
  return is_finite(*output);
}

bool b_inv_matrix_prv(const Vec3& input, Matrix3* output) {
  if (output == nullptr || !is_finite(input)) {
    return false;
  }
  const double p = norm(input);
  if (p < kNearZero) {
    *output = {1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0};
    return true;
  }
  const double c1 = (1.0 - std::cos(p)) / (p * p);
  const double c2 = (p - std::sin(p)) / (p * p * p);
  *output = {
      1.0 - c2 * (input.y * input.y + input.z * input.z),
      c1 * input.z + c2 * input.x * input.y,
      -c1 * input.y + c2 * input.x * input.z,
      -c1 * input.z + c2 * input.x * input.y,
      1.0 - c2 * (input.x * input.x + input.z * input.z),
      c1 * input.x + c2 * input.y * input.z,
      c1 * input.y + c2 * input.z * input.x,
      -c1 * input.x + c2 * input.z * input.y,
      1.0 - c2 * (input.x * input.x + input.y * input.y)};
  return is_finite(*output);
}

Vec3 multiply(const Matrix3& matrix, const Vec3& vector) {
  return {
      matrix.m11 * vector.x + matrix.m12 * vector.y + matrix.m13 * vector.z,
      matrix.m21 * vector.x + matrix.m22 * vector.y + matrix.m23 * vector.z,
      matrix.m31 * vector.x + matrix.m32 * vector.y + matrix.m33 * vector.z};
}

bool d_mrp(const Vec3& mrp, const Vec3& body_rate, Vec3* output) {
  if (output == nullptr || !is_finite(mrp) || !is_finite(body_rate)) {
    return false;
  }
  Matrix3 b_matrix;
  if (!b_matrix_mrp(mrp, &b_matrix)) {
    return false;
  }
  *output = scale(multiply(b_matrix, body_rate), 0.25);
  return is_finite(*output);
}

bool d_gibbs(const Vec3& gibbs, const Vec3& body_rate, Vec3* output) {
  if (output == nullptr || !is_finite(gibbs) || !is_finite(body_rate)) {
    return false;
  }
  Matrix3 b_matrix;
  if (!b_matrix_gibbs(gibbs, &b_matrix)) {
    return false;
  }
  *output = scale(multiply(b_matrix, body_rate), 0.5);
  return is_finite(*output);
}

bool d_prv(const Vec3& prv, const Vec3& body_rate, Vec3* output) {
  if (output == nullptr || !is_finite(prv) || !is_finite(body_rate)) {
    return false;
  }
  Matrix3 b_matrix;
  if (!b_matrix_prv(prv, &b_matrix)) {
    return false;
  }
  *output = multiply(b_matrix, body_rate);
  return is_finite(*output);
}

bool d_mrp_to_omega(const Vec3& mrp, const Vec3& mrp_derivative, Vec3* output) {
  if (output == nullptr || !is_finite(mrp) || !is_finite(mrp_derivative)) {
    return false;
  }
  Matrix3 b_inv_matrix;
  if (!b_inv_matrix_mrp(mrp, &b_inv_matrix)) {
    return false;
  }
  *output = scale(multiply(b_inv_matrix, mrp_derivative), 4.0);
  return is_finite(*output);
}

bool b_dot_matrix_mrp(const Vec3& mrp, const Vec3& mrp_derivative, Matrix3* output) {
  if (output == nullptr || !is_finite(mrp) || !is_finite(mrp_derivative)) {
    return false;
  }
  const double q1 = mrp.x;
  const double q2 = mrp.y;
  const double q3 = mrp.z;
  const double dq1 = mrp_derivative.x;
  const double dq2 = mrp_derivative.y;
  const double dq3 = mrp_derivative.z;
  const double s = -2.0 * dot(mrp, mrp_derivative);
  *output = {
      s + 4.0 * q1 * dq1,
      2.0 * (-dq3 + q1 * dq2 + dq1 * q2),
      2.0 * (dq2 + q1 * dq3 + dq1 * q3),
      2.0 * (dq3 + q1 * dq2 + dq1 * q2),
      s + 4.0 * q2 * dq2,
      2.0 * (-dq1 + q2 * dq3 + dq2 * q3),
      2.0 * (-dq2 + q1 * dq3 + dq1 * q3),
      2.0 * (dq1 + q2 * dq3 + dq2 * q3),
      s + 4.0 * q3 * dq3};
  return is_finite(*output);
}

bool dd_mrp(const Vec3& mrp, const Vec3& mrp_derivative, const Vec3& body_rate, const Vec3& body_acceleration, Vec3* output) {
  if (output == nullptr || !is_finite(mrp) || !is_finite(mrp_derivative) ||
      !is_finite(body_rate) || !is_finite(body_acceleration)) {
    return false;
  }
  Matrix3 b_matrix;
  Matrix3 b_dot_matrix;
  if (!b_matrix_mrp(mrp, &b_matrix) || !b_dot_matrix_mrp(mrp, mrp_derivative, &b_dot_matrix)) {
    return false;
  }
  *output = scale(add(multiply(b_matrix, body_acceleration), multiply(b_dot_matrix, body_rate)), 0.25);
  return is_finite(*output);
}

bool dd_mrp_to_d_omega(const Vec3& mrp, const Vec3& mrp_derivative, const Vec3& mrp_second_derivative, Vec3* output) {
  if (output == nullptr || !is_finite(mrp) || !is_finite(mrp_derivative) || !is_finite(mrp_second_derivative)) {
    return false;
  }
  Matrix3 b_inv_matrix;
  Matrix3 b_dot_matrix;
  if (!b_inv_matrix_mrp(mrp, &b_inv_matrix) || !b_dot_matrix_mrp(mrp, mrp_derivative, &b_dot_matrix)) {
    return false;
  }
  const Vec3 b_inv_times_derivative = multiply(b_inv_matrix, mrp_derivative);
  const Vec3 correction = multiply(b_dot_matrix, b_inv_times_derivative);
  *output = scale(multiply(b_inv_matrix, subtract(mrp_second_derivative, correction)), 4.0);
  return is_finite(*output);
}

OperationResult evaluate_request(const RBKRigidBodyKinematicsRequest* request) {
  if (request == nullptr) {
    return {rbkResultStatus_INVALID_INPUT, "RBKRigidBodyKinematicsRequest is required."};
  }

  OperationResult result;
  switch (request->OPERATION()) {
    case rbkOperationCode_ADD_MRP: {
      if (request->VECTOR_A() == nullptr || request->VECTOR_B() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "ADD_MRP requires VECTOR_A and VECTOR_B."};
      }
      if (!add_mrp(read_vec3(request->VECTOR_A()), read_vec3(request->VECTOR_B()), &result.vector)) {
        return {rbkResultStatus_INVALID_INPUT, "ADD_MRP received invalid MRP vectors."};
      }
      result.has_vector = true;
      return result;
    }
    case rbkOperationCode_SUB_MRP: {
      if (request->VECTOR_A() == nullptr || request->VECTOR_B() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "SUB_MRP requires VECTOR_A and VECTOR_B."};
      }
      if (!sub_mrp(read_vec3(request->VECTOR_A()), read_vec3(request->VECTOR_B()), &result.vector)) {
        return {rbkResultStatus_INVALID_INPUT, "SUB_MRP received invalid MRP vectors."};
      }
      result.has_vector = true;
      return result;
    }
    case rbkOperationCode_ADD_GIBBS: {
      if (request->VECTOR_A() == nullptr || request->VECTOR_B() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "ADD_GIBBS requires VECTOR_A and VECTOR_B."};
      }
      if (!add_gibbs(read_vec3(request->VECTOR_A()), read_vec3(request->VECTOR_B()), &result.vector)) {
        return {rbkResultStatus_INVALID_INPUT, "ADD_GIBBS received invalid Gibbs vectors."};
      }
      result.has_vector = true;
      return result;
    }
    case rbkOperationCode_SUB_GIBBS: {
      if (request->VECTOR_A() == nullptr || request->VECTOR_B() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "SUB_GIBBS requires VECTOR_A and VECTOR_B."};
      }
      if (!sub_gibbs(read_vec3(request->VECTOR_A()), read_vec3(request->VECTOR_B()), &result.vector)) {
        return {rbkResultStatus_INVALID_INPUT, "SUB_GIBBS received invalid Gibbs vectors."};
      }
      result.has_vector = true;
      return result;
    }
    case rbkOperationCode_ADD_PRV: {
      if (request->VECTOR_A() == nullptr || request->VECTOR_B() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "ADD_PRV requires VECTOR_A and VECTOR_B."};
      }
      if (!add_prv(read_vec3(request->VECTOR_A()), read_vec3(request->VECTOR_B()), &result.vector)) {
        return {rbkResultStatus_INVALID_INPUT, "ADD_PRV received invalid principal rotation vectors."};
      }
      result.has_vector = true;
      return result;
    }
    case rbkOperationCode_SUB_PRV: {
      if (request->VECTOR_A() == nullptr || request->VECTOR_B() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "SUB_PRV requires VECTOR_A and VECTOR_B."};
      }
      if (!sub_prv(read_vec3(request->VECTOR_A()), read_vec3(request->VECTOR_B()), &result.vector)) {
        return {rbkResultStatus_INVALID_INPUT, "SUB_PRV received invalid principal rotation vectors."};
      }
      result.has_vector = true;
      return result;
    }
    case rbkOperationCode_ADD_EULER: {
      if (request->VECTOR_A() == nullptr || request->VECTOR_B() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "ADD_EULER requires VECTOR_A and VECTOR_B."};
      }
      if (!add_euler(request->EULER_SEQUENCE(), read_vec3(request->VECTOR_A()), read_vec3(request->VECTOR_B()), &result.vector)) {
        return {rbkResultStatus_INVALID_INPUT, "ADD_EULER received invalid Euler vectors or sequence."};
      }
      result.has_vector = true;
      return result;
    }
    case rbkOperationCode_SUB_EULER: {
      if (request->VECTOR_A() == nullptr || request->VECTOR_B() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "SUB_EULER requires VECTOR_A and VECTOR_B."};
      }
      if (!sub_euler(request->EULER_SEQUENCE(), read_vec3(request->VECTOR_A()), read_vec3(request->VECTOR_B()), &result.vector)) {
        return {rbkResultStatus_INVALID_INPUT, "SUB_EULER received invalid Euler vectors or sequence."};
      }
      result.has_vector = true;
      return result;
    }
    case rbkOperationCode_TILDE_MATRIX: {
      if (request->VECTOR_A() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "TILDE_MATRIX requires VECTOR_A."};
      }
      if (!tilde_matrix(read_vec3(request->VECTOR_A()), &result.matrix)) {
        return {rbkResultStatus_INVALID_INPUT, "TILDE_MATRIX received an invalid vector."};
      }
      result.has_matrix = true;
      return result;
    }
    case rbkOperationCode_M1_ROTATION_MATRIX:
    case rbkOperationCode_M2_ROTATION_MATRIX:
    case rbkOperationCode_M3_ROTATION_MATRIX: {
      const int axis = request->OPERATION() == rbkOperationCode_M1_ROTATION_MATRIX ? 1 :
          request->OPERATION() == rbkOperationCode_M2_ROTATION_MATRIX ? 2 : 3;
      if (!elementary_rotation_matrix(axis, request->ANGLE_RAD(), &result.matrix)) {
        return {rbkResultStatus_INVALID_INPUT, "Rotation matrix operation received an invalid angle."};
      }
      result.has_matrix = true;
      return result;
    }
    case rbkOperationCode_MRP_SHADOW: {
      if (request->VECTOR_A() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "MRP_SHADOW requires VECTOR_A."};
      }
      if (!mrp_shadow(read_vec3(request->VECTOR_A()), &result.vector)) {
        return {rbkResultStatus_INVALID_INPUT, "MRP_SHADOW received an invalid MRP vector."};
      }
      result.has_vector = true;
      return result;
    }
    case rbkOperationCode_MRP_SWITCH: {
      if (request->VECTOR_A() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "MRP_SWITCH requires VECTOR_A."};
      }
      if (!mrp_switch(read_vec3(request->VECTOR_A()), request->SWITCH_THRESHOLD(), &result.vector)) {
        return {rbkResultStatus_INVALID_INPUT, "MRP_SWITCH received an invalid MRP vector or threshold."};
      }
      result.has_vector = true;
      return result;
    }
    case rbkOperationCode_EULER_TO_EP: {
      if (request->VECTOR_A() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "EULER_TO_EP requires VECTOR_A."};
      }
      if (!euler_to_ep(request->EULER_SEQUENCE(), read_vec3(request->VECTOR_A()), &result.quaternion)) {
        return {rbkResultStatus_INVALID_INPUT, "EULER_TO_EP received invalid Euler angles or sequence."};
      }
      result.has_quaternion = true;
      return result;
    }
    case rbkOperationCode_MRP_TO_EP: {
      if (request->VECTOR_A() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "MRP_TO_EP requires VECTOR_A."};
      }
      if (!mrp_to_ep(read_vec3(request->VECTOR_A()), &result.quaternion)) {
        return {rbkResultStatus_INVALID_INPUT, "MRP_TO_EP received an invalid MRP vector."};
      }
      result.has_quaternion = true;
      return result;
    }
    case rbkOperationCode_GIBBS_TO_EP: {
      if (request->VECTOR_A() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "GIBBS_TO_EP requires VECTOR_A."};
      }
      if (!gibbs_to_ep(read_vec3(request->VECTOR_A()), &result.quaternion)) {
        return {rbkResultStatus_INVALID_INPUT, "GIBBS_TO_EP received an invalid Gibbs vector."};
      }
      result.has_quaternion = true;
      return result;
    }
    case rbkOperationCode_PRV_TO_EP: {
      if (request->VECTOR_A() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "PRV_TO_EP requires VECTOR_A."};
      }
      if (!prv_to_ep(read_vec3(request->VECTOR_A()), &result.quaternion)) {
        return {rbkResultStatus_INVALID_INPUT, "PRV_TO_EP received an invalid principal rotation vector."};
      }
      result.has_quaternion = true;
      return result;
    }
    case rbkOperationCode_EP_TO_EULER: {
      if (request->QUATERNION_A() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "EP_TO_EULER requires QUATERNION_A."};
      }
      if (!ep_to_euler(request->EULER_SEQUENCE(), read_quat(request->QUATERNION_A()), &result.vector)) {
        return {rbkResultStatus_INVALID_INPUT, "EP_TO_EULER received an invalid quaternion or Euler sequence."};
      }
      result.has_vector = true;
      return result;
    }
    case rbkOperationCode_EP_TO_MRP: {
      if (request->QUATERNION_A() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "EP_TO_MRP requires QUATERNION_A."};
      }
      if (!ep_to_mrp(read_quat(request->QUATERNION_A()), &result.vector)) {
        return {rbkResultStatus_INVALID_INPUT, "EP_TO_MRP received an invalid quaternion."};
      }
      result.has_vector = true;
      return result;
    }
    case rbkOperationCode_EULER_TO_GIBBS: {
      if (request->VECTOR_A() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "EULER_TO_GIBBS requires VECTOR_A."};
      }
      if (!euler_to_gibbs(request->EULER_SEQUENCE(), read_vec3(request->VECTOR_A()), &result.vector)) {
        return {rbkResultStatus_INVALID_INPUT, "EULER_TO_GIBBS received invalid Euler angles or sequence."};
      }
      result.has_vector = true;
      return result;
    }
    case rbkOperationCode_EP_TO_GIBBS: {
      if (request->QUATERNION_A() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "EP_TO_GIBBS requires QUATERNION_A."};
      }
      if (!ep_to_gibbs(read_quat(request->QUATERNION_A()), &result.vector)) {
        return {rbkResultStatus_INVALID_INPUT, "EP_TO_GIBBS received an invalid quaternion."};
      }
      result.has_vector = true;
      return result;
    }
    case rbkOperationCode_EULER_TO_PRV: {
      if (request->VECTOR_A() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "EULER_TO_PRV requires VECTOR_A."};
      }
      if (!euler_to_prv(request->EULER_SEQUENCE(), read_vec3(request->VECTOR_A()), &result.vector)) {
        return {rbkResultStatus_INVALID_INPUT, "EULER_TO_PRV received invalid Euler angles or sequence."};
      }
      result.has_vector = true;
      return result;
    }
    case rbkOperationCode_EP_TO_PRV: {
      if (request->QUATERNION_A() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "EP_TO_PRV requires QUATERNION_A."};
      }
      if (!ep_to_prv(read_quat(request->QUATERNION_A()), &result.vector)) {
        return {rbkResultStatus_INVALID_INPUT, "EP_TO_PRV received an invalid quaternion."};
      }
      result.has_vector = true;
      return result;
    }
    case rbkOperationCode_DCM_TO_EULER: {
      if (request->MATRIX_A() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "DCM_TO_EULER requires MATRIX_A."};
      }
      if (!dcm_to_euler(request->EULER_SEQUENCE(), read_matrix(request->MATRIX_A()), &result.vector)) {
        return {rbkResultStatus_INVALID_INPUT, "DCM_TO_EULER received an invalid direction cosine matrix or Euler sequence."};
      }
      result.has_vector = true;
      return result;
    }
    case rbkOperationCode_DCM_TO_EP: {
      if (request->MATRIX_A() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "DCM_TO_EP requires MATRIX_A."};
      }
      if (!dcm_to_ep(read_matrix(request->MATRIX_A()), &result.quaternion)) {
        return {rbkResultStatus_INVALID_INPUT, "DCM_TO_EP received an invalid direction cosine matrix."};
      }
      result.has_quaternion = true;
      return result;
    }
    case rbkOperationCode_EULER_TO_DCM: {
      if (request->VECTOR_A() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "EULER_TO_DCM requires VECTOR_A."};
      }
      if (!euler_to_dcm(request->EULER_SEQUENCE(), read_vec3(request->VECTOR_A()), &result.matrix)) {
        return {rbkResultStatus_INVALID_INPUT, "EULER_TO_DCM received invalid Euler angles or sequence."};
      }
      result.has_matrix = true;
      return result;
    }
    case rbkOperationCode_EP_TO_DCM: {
      if (request->QUATERNION_A() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "EP_TO_DCM requires QUATERNION_A."};
      }
      if (!ep_to_dcm(read_quat(request->QUATERNION_A()), &result.matrix)) {
        return {rbkResultStatus_INVALID_INPUT, "EP_TO_DCM received an invalid quaternion."};
      }
      result.has_matrix = true;
      return result;
    }
    case rbkOperationCode_GIBBS_TO_DCM: {
      if (request->VECTOR_A() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "GIBBS_TO_DCM requires VECTOR_A."};
      }
      if (!gibbs_to_dcm(read_vec3(request->VECTOR_A()), &result.matrix)) {
        return {rbkResultStatus_INVALID_INPUT, "GIBBS_TO_DCM received an invalid Gibbs vector."};
      }
      result.has_matrix = true;
      return result;
    }
    case rbkOperationCode_PRV_TO_DCM: {
      if (request->VECTOR_A() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "PRV_TO_DCM requires VECTOR_A."};
      }
      if (!prv_to_dcm(read_vec3(request->VECTOR_A()), &result.matrix)) {
        return {rbkResultStatus_INVALID_INPUT, "PRV_TO_DCM received an invalid principal rotation vector."};
      }
      result.has_matrix = true;
      return result;
    }
    case rbkOperationCode_DCM_TO_MRP: {
      if (request->MATRIX_A() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "DCM_TO_MRP requires MATRIX_A."};
      }
      if (!dcm_to_mrp(read_matrix(request->MATRIX_A()), &result.vector)) {
        return {rbkResultStatus_INVALID_INPUT, "DCM_TO_MRP received an invalid direction cosine matrix."};
      }
      result.has_vector = true;
      return result;
    }
    case rbkOperationCode_DCM_TO_GIBBS: {
      if (request->MATRIX_A() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "DCM_TO_GIBBS requires MATRIX_A."};
      }
      if (!dcm_to_gibbs(read_matrix(request->MATRIX_A()), &result.vector)) {
        return {rbkResultStatus_INVALID_INPUT, "DCM_TO_GIBBS received an invalid direction cosine matrix."};
      }
      result.has_vector = true;
      return result;
    }
    case rbkOperationCode_DCM_TO_PRV: {
      if (request->MATRIX_A() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "DCM_TO_PRV requires MATRIX_A."};
      }
      if (!dcm_to_prv(read_matrix(request->MATRIX_A()), &result.vector)) {
        return {rbkResultStatus_INVALID_INPUT, "DCM_TO_PRV received an invalid direction cosine matrix."};
      }
      result.has_vector = true;
      return result;
    }
    case rbkOperationCode_EULER_TO_MRP: {
      if (request->VECTOR_A() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "EULER_TO_MRP requires VECTOR_A."};
      }
      if (!euler_to_mrp(request->EULER_SEQUENCE(), read_vec3(request->VECTOR_A()), &result.vector)) {
        return {rbkResultStatus_INVALID_INPUT, "EULER_TO_MRP received invalid Euler angles or sequence."};
      }
      result.has_vector = true;
      return result;
    }
    case rbkOperationCode_MRP_TO_DCM: {
      if (request->VECTOR_A() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "MRP_TO_DCM requires VECTOR_A."};
      }
      if (!mrp_to_dcm(read_vec3(request->VECTOR_A()), &result.matrix)) {
        return {rbkResultStatus_INVALID_INPUT, "MRP_TO_DCM received an invalid MRP vector."};
      }
      result.has_matrix = true;
      return result;
    }
    case rbkOperationCode_MRP_TO_EULER: {
      if (request->VECTOR_A() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "MRP_TO_EULER requires VECTOR_A."};
      }
      if (!mrp_to_euler(request->EULER_SEQUENCE(), read_vec3(request->VECTOR_A()), &result.vector)) {
        return {rbkResultStatus_INVALID_INPUT, "MRP_TO_EULER received an invalid MRP vector or Euler sequence."};
      }
      result.has_vector = true;
      return result;
    }
    case rbkOperationCode_MRP_TO_GIBBS: {
      if (request->VECTOR_A() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "MRP_TO_GIBBS requires VECTOR_A."};
      }
      if (!mrp_to_gibbs(read_vec3(request->VECTOR_A()), &result.vector)) {
        return {rbkResultStatus_INVALID_INPUT, "MRP_TO_GIBBS received an invalid MRP vector."};
      }
      result.has_vector = true;
      return result;
    }
    case rbkOperationCode_MRP_TO_PRV: {
      if (request->VECTOR_A() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "MRP_TO_PRV requires VECTOR_A."};
      }
      if (!mrp_to_prv(read_vec3(request->VECTOR_A()), &result.vector)) {
        return {rbkResultStatus_INVALID_INPUT, "MRP_TO_PRV received an invalid MRP vector."};
      }
      result.has_vector = true;
      return result;
    }
    case rbkOperationCode_GIBBS_TO_MRP: {
      if (request->VECTOR_A() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "GIBBS_TO_MRP requires VECTOR_A."};
      }
      if (!gibbs_to_mrp(read_vec3(request->VECTOR_A()), &result.vector)) {
        return {rbkResultStatus_INVALID_INPUT, "GIBBS_TO_MRP received an invalid Gibbs vector."};
      }
      result.has_vector = true;
      return result;
    }
    case rbkOperationCode_GIBBS_TO_EULER: {
      if (request->VECTOR_A() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "GIBBS_TO_EULER requires VECTOR_A."};
      }
      if (!gibbs_to_euler(request->EULER_SEQUENCE(), read_vec3(request->VECTOR_A()), &result.vector)) {
        return {rbkResultStatus_INVALID_INPUT, "GIBBS_TO_EULER received an invalid Gibbs vector or Euler sequence."};
      }
      result.has_vector = true;
      return result;
    }
    case rbkOperationCode_PRV_TO_MRP: {
      if (request->VECTOR_A() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "PRV_TO_MRP requires VECTOR_A."};
      }
      if (!prv_to_mrp(read_vec3(request->VECTOR_A()), &result.vector)) {
        return {rbkResultStatus_INVALID_INPUT, "PRV_TO_MRP received an invalid principal rotation vector."};
      }
      result.has_vector = true;
      return result;
    }
    case rbkOperationCode_PRV_TO_EULER: {
      if (request->VECTOR_A() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "PRV_TO_EULER requires VECTOR_A."};
      }
      if (!prv_to_euler(request->EULER_SEQUENCE(), read_vec3(request->VECTOR_A()), &result.vector)) {
        return {rbkResultStatus_INVALID_INPUT, "PRV_TO_EULER received an invalid principal rotation vector or Euler sequence."};
      }
      result.has_vector = true;
      return result;
    }
    case rbkOperationCode_GIBBS_TO_PRV: {
      if (request->VECTOR_A() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "GIBBS_TO_PRV requires VECTOR_A."};
      }
      if (!gibbs_to_prv(read_vec3(request->VECTOR_A()), &result.vector)) {
        return {rbkResultStatus_INVALID_INPUT, "GIBBS_TO_PRV received an invalid Gibbs vector."};
      }
      result.has_vector = true;
      return result;
    }
    case rbkOperationCode_PRV_TO_GIBBS: {
      if (request->VECTOR_A() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "PRV_TO_GIBBS requires VECTOR_A."};
      }
      if (!prv_to_gibbs(read_vec3(request->VECTOR_A()), &result.vector)) {
        return {rbkResultStatus_INVALID_INPUT, "PRV_TO_GIBBS received an invalid principal rotation vector."};
      }
      result.has_vector = true;
      return result;
    }
    case rbkOperationCode_B_MATRIX_MRP: {
      if (request->VECTOR_A() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "B_MATRIX_MRP requires VECTOR_A."};
      }
      if (!b_matrix_mrp(read_vec3(request->VECTOR_A()), &result.matrix)) {
        return {rbkResultStatus_INVALID_INPUT, "B_MATRIX_MRP received an invalid MRP vector."};
      }
      result.has_matrix = true;
      return result;
    }
    case rbkOperationCode_B_MATRIX_EULER: {
      if (request->VECTOR_A() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "B_MATRIX_EULER requires VECTOR_A."};
      }
      if (!b_matrix_euler(request->EULER_SEQUENCE(), read_vec3(request->VECTOR_A()), &result.matrix)) {
        return {rbkResultStatus_INVALID_INPUT, "B_MATRIX_EULER received invalid Euler angles or sequence."};
      }
      result.has_matrix = true;
      return result;
    }
    case rbkOperationCode_B_MATRIX_GIBBS: {
      if (request->VECTOR_A() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "B_MATRIX_GIBBS requires VECTOR_A."};
      }
      if (!b_matrix_gibbs(read_vec3(request->VECTOR_A()), &result.matrix)) {
        return {rbkResultStatus_INVALID_INPUT, "B_MATRIX_GIBBS received an invalid Gibbs vector."};
      }
      result.has_matrix = true;
      return result;
    }
    case rbkOperationCode_B_MATRIX_PRV: {
      if (request->VECTOR_A() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "B_MATRIX_PRV requires VECTOR_A."};
      }
      if (!b_matrix_prv(read_vec3(request->VECTOR_A()), &result.matrix)) {
        return {rbkResultStatus_INVALID_INPUT, "B_MATRIX_PRV received an invalid principal rotation vector."};
      }
      result.has_matrix = true;
      return result;
    }
    case rbkOperationCode_B_INV_MATRIX_MRP: {
      if (request->VECTOR_A() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "B_INV_MATRIX_MRP requires VECTOR_A."};
      }
      if (!b_inv_matrix_mrp(read_vec3(request->VECTOR_A()), &result.matrix)) {
        return {rbkResultStatus_INVALID_INPUT, "B_INV_MATRIX_MRP received an invalid MRP vector."};
      }
      result.has_matrix = true;
      return result;
    }
    case rbkOperationCode_B_INV_MATRIX_EULER: {
      if (request->VECTOR_A() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "B_INV_MATRIX_EULER requires VECTOR_A."};
      }
      if (!b_inv_matrix_euler(request->EULER_SEQUENCE(), read_vec3(request->VECTOR_A()), &result.matrix)) {
        return {rbkResultStatus_INVALID_INPUT, "B_INV_MATRIX_EULER received invalid Euler angles or sequence."};
      }
      result.has_matrix = true;
      return result;
    }
    case rbkOperationCode_B_INV_MATRIX_GIBBS: {
      if (request->VECTOR_A() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "B_INV_MATRIX_GIBBS requires VECTOR_A."};
      }
      if (!b_inv_matrix_gibbs(read_vec3(request->VECTOR_A()), &result.matrix)) {
        return {rbkResultStatus_INVALID_INPUT, "B_INV_MATRIX_GIBBS received an invalid Gibbs vector."};
      }
      result.has_matrix = true;
      return result;
    }
    case rbkOperationCode_B_INV_MATRIX_PRV: {
      if (request->VECTOR_A() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "B_INV_MATRIX_PRV requires VECTOR_A."};
      }
      if (!b_inv_matrix_prv(read_vec3(request->VECTOR_A()), &result.matrix)) {
        return {rbkResultStatus_INVALID_INPUT, "B_INV_MATRIX_PRV received an invalid principal rotation vector."};
      }
      result.has_matrix = true;
      return result;
    }
    case rbkOperationCode_D_MRP: {
      if (request->VECTOR_A() == nullptr || request->VECTOR_B() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "D_MRP requires VECTOR_A and VECTOR_B."};
      }
      if (!d_mrp(read_vec3(request->VECTOR_A()), read_vec3(request->VECTOR_B()), &result.vector)) {
        return {rbkResultStatus_INVALID_INPUT, "D_MRP received invalid MRP or body-rate vectors."};
      }
      result.has_vector = true;
      return result;
    }
    case rbkOperationCode_D_EULER: {
      if (request->VECTOR_A() == nullptr || request->VECTOR_B() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "D_EULER requires VECTOR_A and VECTOR_B."};
      }
      if (!d_euler(request->EULER_SEQUENCE(), read_vec3(request->VECTOR_A()), read_vec3(request->VECTOR_B()), &result.vector)) {
        return {rbkResultStatus_INVALID_INPUT, "D_EULER received invalid Euler angles, body-rate vector, or sequence."};
      }
      result.has_vector = true;
      return result;
    }
    case rbkOperationCode_D_GIBBS: {
      if (request->VECTOR_A() == nullptr || request->VECTOR_B() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "D_GIBBS requires VECTOR_A and VECTOR_B."};
      }
      if (!d_gibbs(read_vec3(request->VECTOR_A()), read_vec3(request->VECTOR_B()), &result.vector)) {
        return {rbkResultStatus_INVALID_INPUT, "D_GIBBS received invalid Gibbs or body-rate vectors."};
      }
      result.has_vector = true;
      return result;
    }
    case rbkOperationCode_D_PRV: {
      if (request->VECTOR_A() == nullptr || request->VECTOR_B() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "D_PRV requires VECTOR_A and VECTOR_B."};
      }
      if (!d_prv(read_vec3(request->VECTOR_A()), read_vec3(request->VECTOR_B()), &result.vector)) {
        return {rbkResultStatus_INVALID_INPUT, "D_PRV received invalid principal rotation or body-rate vectors."};
      }
      result.has_vector = true;
      return result;
    }
    case rbkOperationCode_D_MRP_TO_OMEGA: {
      if (request->VECTOR_A() == nullptr || request->VECTOR_B() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "D_MRP_TO_OMEGA requires VECTOR_A and VECTOR_B."};
      }
      if (!d_mrp_to_omega(read_vec3(request->VECTOR_A()), read_vec3(request->VECTOR_B()), &result.vector)) {
        return {rbkResultStatus_INVALID_INPUT, "D_MRP_TO_OMEGA received invalid MRP or derivative vectors."};
      }
      result.has_vector = true;
      return result;
    }
    case rbkOperationCode_B_DOT_MATRIX_MRP: {
      if (request->VECTOR_A() == nullptr || request->VECTOR_B() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "B_DOT_MATRIX_MRP requires VECTOR_A and VECTOR_B."};
      }
      if (!b_dot_matrix_mrp(read_vec3(request->VECTOR_A()), read_vec3(request->VECTOR_B()), &result.matrix)) {
        return {rbkResultStatus_INVALID_INPUT, "B_DOT_MATRIX_MRP received invalid MRP or derivative vectors."};
      }
      result.has_matrix = true;
      return result;
    }
    case rbkOperationCode_DD_MRP: {
      if (request->VECTOR_A() == nullptr || request->VECTOR_B() == nullptr ||
          request->VECTOR_C() == nullptr || request->VECTOR_D() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "DD_MRP requires VECTOR_A, VECTOR_B, VECTOR_C, and VECTOR_D."};
      }
      if (!dd_mrp(
              read_vec3(request->VECTOR_A()),
              read_vec3(request->VECTOR_B()),
              read_vec3(request->VECTOR_C()),
              read_vec3(request->VECTOR_D()),
              &result.vector)) {
        return {rbkResultStatus_INVALID_INPUT, "DD_MRP received invalid MRP, derivative, rate, or acceleration vectors."};
      }
      result.has_vector = true;
      return result;
    }
    case rbkOperationCode_DD_MRP_TO_D_OMEGA: {
      if (request->VECTOR_A() == nullptr || request->VECTOR_B() == nullptr || request->VECTOR_C() == nullptr) {
        return {rbkResultStatus_INVALID_INPUT, "DD_MRP_TO_D_OMEGA requires VECTOR_A, VECTOR_B, and VECTOR_C."};
      }
      if (!dd_mrp_to_d_omega(
              read_vec3(request->VECTOR_A()),
              read_vec3(request->VECTOR_B()),
              read_vec3(request->VECTOR_C()),
              &result.vector)) {
        return {rbkResultStatus_INVALID_INPUT, "DD_MRP_TO_D_OMEGA received invalid MRP or derivative vectors."};
      }
      result.has_vector = true;
      return result;
    }
    case rbkOperationCode_UNKNOWN:
    default:
      return {rbkResultStatus_UNSUPPORTED_OPERATION, "RBK operation is not supported."};
  }
}

int emit_result(const OperationResult& operation, const char* trace_id) {
  ::flatbuffers::FlatBufferBuilder builder(1024);

  ::flatbuffers::Offset<RBKVector3> vector_offset = 0;
  if (operation.has_vector) {
    vector_offset = CreateRBKVector3(builder, operation.vector.x, operation.vector.y, operation.vector.z);
  }

  ::flatbuffers::Offset<RBKQuaternion> quaternion_offset = 0;
  if (operation.has_quaternion) {
    quaternion_offset = CreateRBKQuaternion(
        builder,
        operation.quaternion.q0,
        operation.quaternion.q1,
        operation.quaternion.q2,
        operation.quaternion.q3);
  }

  ::flatbuffers::Offset<RBKMatrix3> matrix_offset = 0;
  if (operation.has_matrix) {
    matrix_offset = CreateRBKMatrix3(
        builder,
        operation.matrix.m11,
        operation.matrix.m12,
        operation.matrix.m13,
        operation.matrix.m21,
        operation.matrix.m22,
        operation.matrix.m23,
        operation.matrix.m31,
        operation.matrix.m32,
        operation.matrix.m33);
  }

  const auto result = CreateRBKRigidBodyKinematicsResultDirect(
      builder,
      operation.status,
      operation.message,
      vector_offset,
      quaternion_offset,
      matrix_offset,
      trace_id);
  const auto envelope = CreateRBK(builder, 0, result);
  FinishRBKBuffer(builder, envelope);

  if (plugin_push_output(
          "result",
          "RBK.fbs",
          "$RBK",
          builder.GetBufferPointer(),
          static_cast<uint32_t>(builder.GetSize())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit RBK rigid-body kinematics result.");
    return 1;
  }
  return 0;
}

const plugin_input_frame_t* find_request_frame() {
  const uint32_t input_count = plugin_get_input_count();
  for (uint32_t index = 0; index < input_count; ++index) {
    const plugin_input_frame_t* frame = plugin_get_input_frame(index);
    if (frame != nullptr && frame->port_id != nullptr && std::strcmp(frame->port_id, "request") == 0) {
      return frame;
    }
  }
  return nullptr;
}

}  // namespace

extern "C" int evaluate_rigid_body_kinematics(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* frame = find_request_frame();
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length == 0) {
    plugin_set_error("missing-request", "No RBK rigid-body kinematics request frame was provided.");
    return 3;
  }
  if (!RBKBufferHasIdentifier(frame->payload)) {
    plugin_set_error("invalid-request-buffer", "Input is not an SDS RBK FlatBuffer.");
    return 3;
  }

  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyRBKBuffer(verifier)) {
    plugin_set_error("invalid-request-buffer", "Input is not a valid SDS RBK FlatBuffer.");
    return 3;
  }

  const RBK* envelope = GetRBK(frame->payload);
  const RBKRigidBodyKinematicsRequest* request = envelope ? envelope->RIGID_BODY_REQUEST() : nullptr;
  const std::string trace_id = request != nullptr && request->TRACE_ID() != nullptr ? request->TRACE_ID()->str() : "";
  const OperationResult result = evaluate_request(request);
  return emit_result(result, trace_id.empty() ? nullptr : trace_id.c_str());
}
