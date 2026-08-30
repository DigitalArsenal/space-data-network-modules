#include "space_data_module_invoke.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace {

constexpr double kJulianDateUnixEpoch = 2440587.5;
constexpr double kSecondsPerDay = 86400.0;
constexpr double kSecondsPerWeek = 7.0 * kSecondsPerDay;
constexpr double kHalfDaySeconds = kSecondsPerDay / 2.0;
constexpr double kJulianCenturySeconds = 36525.0 * kSecondsPerDay;
constexpr double kModifiedJulianDateOffset = 2400000.5;
constexpr double kModifiedJulianDateUnixEpoch = kJulianDateUnixEpoch - kModifiedJulianDateOffset;
constexpr double kTtMinusTaiSeconds = 32.184;
constexpr double kGpsFamilyMinusTaiSeconds = -19.0;
constexpr double kBdtMinusTaiSeconds = -33.0;
// A1 - TAI = 0.0343817 s EXACTLY. The A1 atomic time scale (US Naval
// Observatory) was set equal to UT2 at 1958 January 1.0, and its offset from
// TAI has been that fixed constant ever since -- it is a DEFINITION, not a
// measurement, which is why it carries no epoch dependence and no uncertainty.
// GMAT exposes A1 as a first-class scale; this is the whole of the difference.
constexpr double kA1MinusTaiSeconds = 0.0343817;
constexpr double kGlonassMinusUtcSeconds = 3.0 * 3600.0;
constexpr double kTcgLgRate = 6.969290134e-10;
constexpr double kTcbLbRate = 1.550519768e-8;
constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kRadiansPerDegree = kPi / 180.0;
constexpr double kTdbG0Radians = 357.53 * kRadiansPerDegree;
constexpr double kTdbG1RadiansPerDay = 0.9856003 * kRadiansPerDegree;
constexpr double kTdbSinGFactorSeconds = 0.001658;
constexpr double kTdbTwoSin2GFactorSeconds = 2.0 * 0.000014;
constexpr double kGmstC0Seconds = 24110.54841;
constexpr double kGmstC1Seconds = 8640184.812866;
constexpr double kGmstC2Seconds = 0.093104;
constexpr double kGmstC3Seconds = -0.0000062;
constexpr int kCcsdsUnsegmentedEpochMask = 0x70;
constexpr int kCcsdsUnsegmentedCcsdsEpoch = 0x10;
constexpr int kCcsdsUnsegmentedAgencyEpoch = 0x20;
constexpr int kJ2000DayAtUnixEpoch = -10957;
constexpr int kGregorianCutoverJ2000Day = -152384;
constexpr int kProlepticJulianCutoverJ2000Day = -730122;
constexpr int kCommonYearPreviousMonthEndDays[] = {0, 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334};
constexpr int kLeapYearPreviousMonthEndDays[] = {0, 0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335};

struct DateTime {
  int year = 1970;
  int month = 1;
  int day = 1;
  int hour = 0;
  int minute = 0;
  int second = 0;
  int microsecond = 0;
  int utc_offset_minutes = 0;
  bool leap_second = false;
  bool large_leap_second = false;
};

struct LeapEntry {
  int year;
  int month;
  int day;
  int tai_minus_utc;
};

struct HistoricalUtcTaiEntry {
  int year;
  int month;
  int day;
  double base_tai_minus_utc;
  int reference_mjd;
  double slope_seconds_per_day;
};

constexpr HistoricalUtcTaiEntry kHistoricalUtcTaiEntries[] = {
    {1961, 1, 1, 1.4228180, 37300, 0.001296},
    {1961, 8, 1, 1.3728180, 37300, 0.001296},
    {1962, 1, 1, 1.8458580, 37665, 0.0011232},
    {1963, 11, 1, 1.9458580, 37665, 0.0011232},
    {1964, 1, 1, 3.2401300, 38761, 0.001296},
    {1964, 4, 1, 3.3401300, 38761, 0.001296},
    {1964, 9, 1, 3.4401300, 38761, 0.001296},
    {1965, 1, 1, 3.5401300, 38761, 0.001296},
    {1965, 3, 1, 3.6401300, 38761, 0.001296},
    {1965, 7, 1, 3.7401300, 38761, 0.001296},
    {1965, 9, 1, 3.8401300, 38761, 0.001296},
    {1966, 1, 1, 4.3131700, 39126, 0.002592},
    {1968, 2, 1, 4.2131700, 39126, 0.002592},
};

constexpr LeapEntry kLeapEntries[] = {
    {1972, 1, 1, 10}, {1972, 7, 1, 11}, {1973, 1, 1, 12},
    {1974, 1, 1, 13}, {1975, 1, 1, 14}, {1976, 1, 1, 15},
    {1977, 1, 1, 16}, {1978, 1, 1, 17}, {1979, 1, 1, 18},
    {1980, 1, 1, 19}, {1981, 7, 1, 20}, {1982, 7, 1, 21},
    {1983, 7, 1, 22}, {1985, 7, 1, 23}, {1988, 1, 1, 24},
    {1990, 1, 1, 25}, {1991, 1, 1, 26}, {1992, 7, 1, 27},
    {1993, 7, 1, 28}, {1994, 7, 1, 29}, {1996, 1, 1, 30},
    {1997, 7, 1, 31}, {1999, 1, 1, 32}, {2006, 1, 1, 33},
    {2009, 1, 1, 34}, {2012, 7, 1, 35}, {2015, 7, 1, 36},
    {2017, 1, 1, 37},
};

bool orekit_julian_leap_year(int year) {
  return year % 4 == 0;
}

bool orekit_gregorian_leap_year(int year) {
  return year % 4 == 0 && (year % 400 == 0 || year % 100 != 0);
}

int64_t orekit_proleptic_julian_last_j2000_day_of_year(int year) {
  return 365LL * year + (year + 1) / 4 - 730123;
}

int64_t orekit_julian_last_j2000_day_of_year(int year) {
  return 365LL * year + year / 4 - 730122;
}

int64_t orekit_gregorian_last_j2000_day_of_year(int year) {
  return 365LL * year + year / 4 - year / 100 + year / 400 - 730120;
}

bool orekit_date_uses_julian_calendar(int year, unsigned month, unsigned day) {
  return year < 1582 || month < 10 || (month < 11 && day < 5);
}

int day_in_year_for_month_day(bool leap_year, unsigned month, unsigned day) {
  return (leap_year ? kLeapYearPreviousMonthEndDays : kCommonYearPreviousMonthEndDays)[month] +
         static_cast<int>(day);
}

int64_t j2000_day_from_civil(int year, unsigned month, unsigned day) {
  if (year < 1) {
    return orekit_proleptic_julian_last_j2000_day_of_year(year - 1) +
           day_in_year_for_month_day(orekit_julian_leap_year(year), month, day);
  }
  if (year < 1583 && orekit_date_uses_julian_calendar(year, month, day)) {
    return orekit_julian_last_j2000_day_of_year(year - 1) +
           day_in_year_for_month_day(orekit_julian_leap_year(year), month, day);
  }
  return orekit_gregorian_last_j2000_day_of_year(year - 1) +
         day_in_year_for_month_day(orekit_gregorian_leap_year(year), month, day);
}

int orekit_proleptic_julian_year_from_j2000_day(int64_t j2000_day) {
  return static_cast<int>(-((-4LL * j2000_day - 2920488LL) / 1461LL));
}

int orekit_julian_year_from_j2000_day(int64_t j2000_day) {
  return static_cast<int>((4LL * j2000_day + 2921948LL) / 1461LL);
}

int orekit_gregorian_year_from_j2000_day(int64_t j2000_day) {
  int year = static_cast<int>((400LL * j2000_day + 292194288LL) / 146097LL);
  if (j2000_day <= orekit_gregorian_last_j2000_day_of_year(year - 1)) {
    --year;
  }
  return year;
}

int64_t days_from_civil(int year, unsigned month, unsigned day) {
  return j2000_day_from_civil(year, month, day) - kJ2000DayAtUnixEpoch;
}

void civil_from_days(int64_t days_since_unix_epoch, int* year, unsigned* month, unsigned* day) {
  const int64_t j2000_day = days_since_unix_epoch + kJ2000DayAtUnixEpoch;
  bool leap_year = false;
  int64_t last_day_of_previous_year = 0;
  if (j2000_day < kGregorianCutoverJ2000Day) {
    if (j2000_day > kProlepticJulianCutoverJ2000Day) {
      *year = orekit_julian_year_from_j2000_day(j2000_day);
      leap_year = orekit_julian_leap_year(*year);
      last_day_of_previous_year = orekit_julian_last_j2000_day_of_year(*year - 1);
    } else {
      *year = orekit_proleptic_julian_year_from_j2000_day(j2000_day);
      leap_year = orekit_julian_leap_year(*year);
      last_day_of_previous_year = orekit_proleptic_julian_last_j2000_day_of_year(*year - 1);
    }
  } else {
    *year = orekit_gregorian_year_from_j2000_day(j2000_day);
    leap_year = orekit_gregorian_leap_year(*year);
    last_day_of_previous_year = orekit_gregorian_last_j2000_day_of_year(*year - 1);
  }

  const int day_in_year = static_cast<int>(j2000_day - last_day_of_previous_year);
  const int* previous_month_end_days =
      leap_year ? kLeapYearPreviousMonthEndDays : kCommonYearPreviousMonthEndDays;
  unsigned parsed_month = 1;
  while (parsed_month < 12 && day_in_year > previous_month_end_days[parsed_month + 1]) {
    ++parsed_month;
  }
  *month = parsed_month;
  *day = static_cast<unsigned>(day_in_year - previous_month_end_days[parsed_month]);
}

bool valid_civil_date(int year, int month, int day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  int normalized_year = 0;
  unsigned normalized_month = 0;
  unsigned normalized_day = 0;
  civil_from_days(days_from_civil(year, static_cast<unsigned>(month), static_cast<unsigned>(day)),
                  &normalized_year,
                  &normalized_month,
                  &normalized_day);
  return normalized_year == year &&
         normalized_month == static_cast<unsigned>(month) &&
         normalized_day == static_cast<unsigned>(day);
}

double unix_seconds_from_datetime(const DateTime& value) {
  const int64_t days = days_from_civil(value.year, value.month, value.day);
  return static_cast<double>(days) * kSecondsPerDay +
         value.hour * 3600.0 +
         value.minute * 60.0 +
         value.second +
         value.microsecond / 1000000.0;
}

double local_epoch_seconds(int year, int month, int day) {
  return static_cast<double>(days_from_civil(year, month, day)) * kSecondsPerDay;
}

bool parse_fixed_digits(const char* text, int count, int* value) {
  if (text == nullptr || value == nullptr || count <= 0) {
    return false;
  }
  int parsed = 0;
  for (int index = 0; index < count; ++index) {
    const char character = text[index];
    if (character < '0' || character > '9') {
      return false;
    }
    parsed = parsed * 10 + (character - '0');
  }
  *value = parsed;
  return true;
}

int iso_weekday_from_days(int64_t days) {
  int weekday = static_cast<int>((days + 3) % 7);
  if (weekday < 0) {
    weekday += 7;
  }
  return weekday + 1;
}

int64_t orekit_first_week_monday_days(int year) {
  const int64_t jan4 = days_from_civil(year, 1, 4);
  return jan4 - (iso_weekday_from_days(jan4) - 1);
}

int orekit_calendar_week_from_days(int64_t days) {
  int year = 0;
  unsigned month = 1;
  unsigned day = 1;
  civil_from_days(days, &year, &month, &day);

  const int64_t first_week_monday = orekit_first_week_monday_days(year);
  int64_t days_since_first_monday = days - first_week_monday;
  if (days_since_first_monday < 0) {
    days_since_first_monday += first_week_monday - orekit_first_week_monday_days(year - 1);
  } else {
    const int64_t week_year_length = orekit_first_week_monday_days(year + 1) - first_week_monday;
    if (days_since_first_monday >= week_year_length) {
      days_since_first_monday -= week_year_length;
    }
  }
  return 1 + static_cast<int>(days_since_first_monday / 7);
}

bool set_midnight_from_days(int64_t days, DateTime* out) {
  if (out == nullptr) {
    return false;
  }
  unsigned month = 1;
  unsigned day = 1;
  civil_from_days(days, &out->year, &month, &day);
  out->month = static_cast<int>(month);
  out->day = static_cast<int>(day);
  out->hour = 0;
  out->minute = 0;
  out->second = 0;
  out->microsecond = 0;
  out->utc_offset_minutes = 0;
  out->leap_second = false;
  return true;
}

bool set_midnight_from_orekit_week_date(int year, int week, int day, DateTime* out) {
  if (week < 1 || week > 53 || day < 1 || day > 7) {
    return false;
  }
  const int64_t week1_monday = orekit_first_week_monday_days(year);
  const int64_t target_day = week1_monday + static_cast<int64_t>(week - 1) * 7 + (day - 1);
  if (orekit_calendar_week_from_days(target_day) != week ||
      iso_weekday_from_days(target_day) != day) {
    return false;
  }
  return set_midnight_from_days(target_day, out);
}

bool parse_orekit_date_only(const char* text, DateTime* out) {
  if (text == nullptr || out == nullptr) {
    return false;
  }
  const size_t length = std::strlen(text);
  const bool signed_year = text[0] == '-';
  const char* body = signed_year ? text + 1 : text;
  const size_t body_length = signed_year ? length - 1 : length;
  const int year_sign = signed_year ? -1 : 1;
  int year = 0;

  if (body_length == 10 && body[4] == '-' && body[7] == '-') {
    int month = 0;
    int day = 0;
    if (!parse_fixed_digits(body, 4, &year) ||
        !parse_fixed_digits(body + 5, 2, &month) ||
        !parse_fixed_digits(body + 8, 2, &day)) {
      return false;
    }
    year *= year_sign;
    if (!valid_civil_date(year, month, day)) {
      return false;
    }
    return set_midnight_from_days(days_from_civil(year, static_cast<unsigned>(month), static_cast<unsigned>(day)),
                                  out);
  }

  if (body_length == 8 && body[4] == '-') {
    int day_of_year = 0;
    if (!parse_fixed_digits(body, 4, &year) ||
        !parse_fixed_digits(body + 5, 3, &day_of_year)) {
      return false;
    }
    year *= year_sign;
    const int64_t first_day = days_from_civil(year, 1, 1);
    const int64_t next_first_day = days_from_civil(year + 1, 1, 1);
    if (day_of_year < 1 || day_of_year > next_first_day - first_day) {
      return false;
    }
    return set_midnight_from_days(first_day + day_of_year - 1, out);
  }

  if (body_length == 10 && body[4] == '-' && body[5] == 'W' && body[8] == '-') {
    int week = 0;
    int day = 0;
    if (!parse_fixed_digits(body, 4, &year) ||
        !parse_fixed_digits(body + 6, 2, &week) ||
        !parse_fixed_digits(body + 9, 1, &day) ||
        week < 1 ||
        week > 53 ||
        day < 1 ||
        day > 7) {
      return false;
    }
    year *= year_sign;
    return set_midnight_from_orekit_week_date(year, week, day, out);
  }

  if (body_length == 8 && body[4] == 'W') {
    int week = 0;
    int day = 0;
    if (!parse_fixed_digits(body, 4, &year) ||
        !parse_fixed_digits(body + 5, 2, &week) ||
        !parse_fixed_digits(body + 7, 1, &day) ||
        week < 1 ||
        week > 53 ||
        day < 1 ||
        day > 7) {
      return false;
    }
    year *= year_sign;
    return set_midnight_from_orekit_week_date(year, week, day, out);
  }

  if (body_length == 8) {
    int month = 0;
    int day = 0;
    if (!parse_fixed_digits(body, 4, &year) ||
        !parse_fixed_digits(body + 4, 2, &month) ||
        !parse_fixed_digits(body + 6, 2, &day)) {
      return false;
    }
    year *= year_sign;
    if (!valid_civil_date(year, month, day)) {
      return false;
    }
    return set_midnight_from_days(days_from_civil(year, static_cast<unsigned>(month), static_cast<unsigned>(day)),
                                  out);
  }

  if (body_length == 7) {
    int day_of_year = 0;
    if (!parse_fixed_digits(body, 4, &year) ||
        !parse_fixed_digits(body + 4, 3, &day_of_year)) {
      return false;
    }
    year *= year_sign;
    const int64_t first_day = days_from_civil(year, 1, 1);
    const int64_t next_first_day = days_from_civil(year + 1, 1, 1);
    if (day_of_year < 1 || day_of_year > next_first_day - first_day) {
      return false;
    }
    return set_midnight_from_days(first_day + day_of_year - 1, out);
  }

  return false;
}

double gnss_seconds_epoch_for_scale(timingStandard scale) {
  switch (scale) {
    case timingStandard_GST:
    case timingStandard_NAVIC:
      return local_epoch_seconds(1999, 8, 22);
    case timingStandard_BDT:
      return local_epoch_seconds(2006, 1, 1);
    case timingStandard_GPS:
    case timingStandard_QZSS:
    case timingStandard_SBAS:
    default:
      return local_epoch_seconds(1980, 1, 6);
  }
}

double ccsds_epoch_tai_seconds() {
  return local_epoch_seconds(1958, 1, 1);
}

bool supports_gnss_seconds_representation(timingStandard scale) {
  switch (scale) {
    case timingStandard_GPS:
    case timingStandard_QZSS:
    case timingStandard_SBAS:
    case timingStandard_GST:
    case timingStandard_BDT:
    case timingStandard_NAVIC:
      return true;
    default:
      return false;
  }
}

int gnss_rollover_cycle_weeks(timingStandard scale) {
  switch (scale) {
    case timingStandard_GST:
      return 4096;
    case timingStandard_BDT:
      return 8192;
    case timingStandard_GPS:
    case timingStandard_QZSS:
    case timingStandard_SBAS:
    case timingStandard_NAVIC:
      return 1024;
    default:
      return 0;
  }
}

bool is_gnss_epoch_representation(timEpochRepresentation format) {
  return format == timEpochRepresentation_GPS_SECONDS ||
         format == timEpochRepresentation_GNSS_WEEK_SECONDS;
}

const char* gnss_epoch_representation_name(timEpochRepresentation format) {
  switch (format) {
    case timEpochRepresentation_GNSS_WEEK_SECONDS:
      return "GNSS_WEEK_SECONDS";
    case timEpochRepresentation_GPS_SECONDS:
    default:
      return "GPS_SECONDS";
  }
}

DateTime datetime_from_unix_seconds(double seconds) {
  double whole_double = std::floor(seconds);
  double fraction = seconds - whole_double;
  int64_t whole = static_cast<int64_t>(whole_double);
  int microsecond = static_cast<int>(std::llround(fraction * 1000000.0));
  if (microsecond >= 1000000) {
    microsecond -= 1000000;
    ++whole;
  }
  if (microsecond < 0) {
    microsecond += 1000000;
    --whole;
  }

  int64_t days = whole / 86400;
  int64_t sod = whole % 86400;
  if (sod < 0) {
    sod += 86400;
    --days;
  }

  DateTime value;
  unsigned month = 1;
  unsigned day = 1;
  civil_from_days(days, &value.year, &month, &day);
  value.month = static_cast<int>(month);
  value.day = static_cast<int>(day);
  value.hour = static_cast<int>(sod / 3600);
  value.minute = static_cast<int>((sod % 3600) / 60);
  value.second = static_cast<int>(sod % 60);
  value.microsecond = microsecond;
  return value;
}

bool parse_orekit_time_components(const char* text, DateTime* out) {
  if (text == nullptr || out == nullptr) {
    return false;
  }

  const char* cursor = text;
  int hour = 0;
  int minute = 0;
  int second = 0;
  int microsecond = 0;
  int utc_offset_minutes = 0;

  if (!parse_fixed_digits(cursor, 2, &hour)) {
    return false;
  }
  cursor += 2;
  if (*cursor == ':') {
    ++cursor;
  }
  if (!parse_fixed_digits(cursor, 2, &minute)) {
    return false;
  }
  cursor += 2;
  if (*cursor == ':') {
    ++cursor;
  }

  if (*cursor >= '0' && *cursor <= '9') {
    if (!parse_fixed_digits(cursor, 2, &second)) {
      return false;
    }
    cursor += 2;
    if (*cursor == '.' || *cursor == ',') {
      ++cursor;
      int digits = 0;
      int micros = 0;
      while (*cursor >= '0' && *cursor <= '9') {
        if (digits < 6) {
          micros = micros * 10 + (*cursor - '0');
        }
        ++digits;
        ++cursor;
      }
      if (digits == 0) {
        return false;
      }
      while (digits < 6) {
        micros *= 10;
        ++digits;
      }
      microsecond = micros;
    }
  }

  if (hour > 23 || minute > 59 || second >= 62) {
    return false;
  }

  if (*cursor == 'Z') {
    ++cursor;
    if (*cursor != '\0') {
      return false;
    }
  } else if (*cursor == '+' || *cursor == '-') {
    const int sign = *cursor == '+' ? 1 : -1;
    ++cursor;
    int offset_hours = 0;
    if (!parse_fixed_digits(cursor, 2, &offset_hours)) {
      return false;
    }
    cursor += 2;
    int offset_minutes = 0;
    if (*cursor == ':') {
      ++cursor;
      if (!parse_fixed_digits(cursor, 2, &offset_minutes)) {
        return false;
      }
      cursor += 2;
    } else if (*cursor >= '0' && *cursor <= '9') {
      if (!parse_fixed_digits(cursor, 2, &offset_minutes)) {
        return false;
      }
      cursor += 2;
    }
    if (offset_minutes >= 60 || *cursor != '\0') {
      return false;
    }
    utc_offset_minutes = sign * (offset_hours * 60 + offset_minutes);
  } else if (*cursor != '\0') {
    return false;
  }

  out->hour = hour;
  out->minute = minute;
  out->second = second;
  out->microsecond = microsecond;
  out->utc_offset_minutes = utc_offset_minutes;
  out->leap_second = second >= 60;
  out->large_leap_second = second > 60;
  return true;
}

bool parse_orekit_datetime(const char* text, DateTime* out) {
  if (text == nullptr || out == nullptr) {
    return false;
  }
  const char* separator = std::strchr(text, 'T');
  if (separator == nullptr || separator == text || separator[1] == '\0') {
    return false;
  }

  std::string date_text(text, static_cast<size_t>(separator - text));
  DateTime parsed;
  if (!parse_orekit_date_only(date_text.c_str(), &parsed)) {
    return false;
  }
  if (!parse_orekit_time_components(separator + 1, &parsed)) {
    return false;
  }
  *out = parsed;
  return true;
}

bool parse_iso8601(const char* text, DateTime* out) {
  if (text == nullptr || out == nullptr) {
    return false;
  }
  if (parse_orekit_date_only(text, out)) {
    return true;
  }
  if (parse_orekit_datetime(text, out)) {
    if (!valid_civil_date(out->year, out->month, out->day)) {
      return false;
    }
    return true;
  }
  return false;
}

std::string format_iso8601(double seconds, bool utc_suffix, bool utc_leap_second = false) {
  const DateTime value = datetime_from_unix_seconds(utc_leap_second ? seconds - 1.0 : seconds);
  char buffer[48];
  std::snprintf(
      buffer,
      sizeof(buffer),
      "%04d-%02d-%02dT%02d:%02d:%02d.%06d%s",
      value.year,
      value.month,
      value.day,
      value.hour,
      value.minute,
      utc_leap_second ? 60 : value.second,
      value.microsecond,
      utc_suffix ? "Z" : "");
  return std::string(buffer);
}

double tai_minus_utc_for_utc_seconds(double utc_seconds) {
  const double post_linear_utc_seconds =
      static_cast<double>(days_from_civil(1972, 1, 1)) * kSecondsPerDay;
  if (utc_seconds < post_linear_utc_seconds) {
    const HistoricalUtcTaiEntry* selected = nullptr;
    for (const HistoricalUtcTaiEntry& entry : kHistoricalUtcTaiEntries) {
      const double entry_seconds =
          static_cast<double>(days_from_civil(entry.year, entry.month, entry.day)) * kSecondsPerDay;
      if (utc_seconds >= entry_seconds) {
        selected = &entry;
      } else {
        break;
      }
    }
    if (selected == nullptr) {
      return 0.0;
    }
    const double mjd = utc_seconds / kSecondsPerDay + kModifiedJulianDateUnixEpoch;
    return selected->base_tai_minus_utc +
           (mjd - static_cast<double>(selected->reference_mjd)) * selected->slope_seconds_per_day;
  }

  double offset = 0.0;
  for (const LeapEntry& entry : kLeapEntries) {
    const double entry_seconds =
        static_cast<double>(days_from_civil(entry.year, entry.month, entry.day)) * kSecondsPerDay;
    if (utc_seconds >= entry_seconds) {
      offset = static_cast<double>(entry.tai_minus_utc);
    } else {
      break;
    }
  }
  return offset;
}

double tai_minus_utc_for_utc_components(const DateTime& value) {
  const int minute_in_day = value.hour * 60 + value.minute - value.utc_offset_minutes;
  const int day_correction =
      minute_in_day < 0 ? (minute_in_day - 1439) / 1440 : minute_in_day / 1440;
  const int64_t lookup_days =
      days_from_civil(value.year, static_cast<unsigned>(value.month), static_cast<unsigned>(value.day)) +
      day_correction;
  const double lookup_midnight_seconds = static_cast<double>(lookup_days) * kSecondsPerDay;
  const double component_seconds = unix_seconds_from_datetime(value);
  const double post_linear_utc_seconds =
      static_cast<double>(days_from_civil(1972, 1, 1)) * kSecondsPerDay;

  if (lookup_midnight_seconds < post_linear_utc_seconds) {
    const HistoricalUtcTaiEntry* selected = nullptr;
    for (const HistoricalUtcTaiEntry& entry : kHistoricalUtcTaiEntries) {
      const int64_t entry_days = days_from_civil(entry.year, entry.month, entry.day);
      if (lookup_days >= entry_days) {
        selected = &entry;
      } else {
        break;
      }
    }
    if (selected == nullptr) {
      return 0.0;
    }
    const double mjd = component_seconds / kSecondsPerDay + kModifiedJulianDateUnixEpoch;
    return selected->base_tai_minus_utc +
           (mjd - static_cast<double>(selected->reference_mjd)) * selected->slope_seconds_per_day;
  }

  double offset = 0.0;
  for (const LeapEntry& entry : kLeapEntries) {
    const int64_t entry_days = days_from_civil(entry.year, entry.month, entry.day);
    if (lookup_days >= entry_days) {
      offset = entry.tai_minus_utc;
    } else {
      break;
    }
  }
  return offset;
}

double tai_minus_utc_for_tai_seconds(double tai_seconds) {
  double utc_guess = tai_seconds - 37.0;
  double offset = 37.0;
  for (int index = 0; index < 8; ++index) {
    offset = tai_minus_utc_for_utc_seconds(utc_guess);
    utc_guess = tai_seconds - offset;
  }
  return offset;
}

bool utc_leap_second_from_tai(double tai_seconds, double* normalized_utc_seconds, int* tai_minus_utc) {
  const size_t count = sizeof(kLeapEntries) / sizeof(kLeapEntries[0]);
  if (count < 2) {
    return false;
  }

  int previous_offset = kLeapEntries[0].tai_minus_utc;
  for (size_t index = 1; index < count; ++index) {
    const LeapEntry& entry = kLeapEntries[index];
    const double transition_utc_seconds =
        static_cast<double>(days_from_civil(entry.year, entry.month, entry.day)) * kSecondsPerDay;
    if (entry.tai_minus_utc > previous_offset) {
      const double leap_tai_start = transition_utc_seconds + previous_offset;
      const double leap_tai_end = transition_utc_seconds + entry.tai_minus_utc;
      if (tai_seconds >= leap_tai_start && tai_seconds < leap_tai_end) {
        if (normalized_utc_seconds != nullptr) {
          *normalized_utc_seconds = transition_utc_seconds + (tai_seconds - leap_tai_start);
        }
        if (tai_minus_utc != nullptr) {
          *tai_minus_utc = previous_offset;
        }
        return true;
      }
    }
    previous_offset = entry.tai_minus_utc;
  }

  return false;
}

bool supported_without_eop(timingStandard scale) {
  return scale == timingStandard_UTC ||
         scale == timingStandard_TAI ||
         scale == timingStandard_TT ||
         scale == timingStandard_GPS ||
         scale == timingStandard_GLONASS ||
         scale == timingStandard_GST ||
         scale == timingStandard_QZSS ||
         scale == timingStandard_SBAS ||
         scale == timingStandard_BDT ||
         scale == timingStandard_NAVIC ||
         scale == timingStandard_TCG ||
         scale == timingStandard_TDB ||
         scale == timingStandard_TCB ||
         scale == timingStandard_GMST ||
         scale == timingStandard_A1;
}

bool scale_uses_utc_leap_labels(timingStandard scale) {
  return scale == timingStandard_UTC || scale == timingStandard_GLONASS;
}

double constant_offset_from_tai(timingStandard scale) {
  switch (scale) {
    case timingStandard_TAI:
      return 0.0;
    case timingStandard_TT:
      return kTtMinusTaiSeconds;
    case timingStandard_GPS:
    case timingStandard_GST:
    case timingStandard_QZSS:
    case timingStandard_SBAS:
    case timingStandard_NAVIC:
      return kGpsFamilyMinusTaiSeconds;
    case timingStandard_BDT:
      return kBdtMinusTaiSeconds;
    case timingStandard_A1:
      return kA1MinusTaiSeconds;
    default:
      return 0.0;
  }
}

double glonass_offset_from_tai_for_local(
    double glonass_seconds,
    const TIMConversionRequest* request,
    bool leap_second) {
  if (request != nullptr && request->HAS_TAI_MINUS_UTC()) {
    return kGlonassMinusUtcSeconds - request->TAI_MINUS_UTC_SECONDS();
  }
  const double utc_seconds = glonass_seconds - kGlonassMinusUtcSeconds;
  const double offset_lookup_seconds = leap_second ? utc_seconds - 1.0 : utc_seconds;
  return kGlonassMinusUtcSeconds - tai_minus_utc_for_utc_seconds(offset_lookup_seconds);
}

double glonass_offset_from_tai_for_tai(double tai_seconds, const TIMConversionRequest* request) {
  if (request != nullptr && request->HAS_TAI_MINUS_UTC()) {
    return kGlonassMinusUtcSeconds - request->TAI_MINUS_UTC_SECONDS();
  }
  int leap_offset = 0;
  if (utc_leap_second_from_tai(tai_seconds, nullptr, &leap_offset)) {
    return kGlonassMinusUtcSeconds - static_cast<double>(leap_offset);
  }
  return kGlonassMinusUtcSeconds - tai_minus_utc_for_tai_seconds(tai_seconds);
}

double tcg_reference_tai_seconds() {
  return static_cast<double>(days_from_civil(1977, 1, 1)) * kSecondsPerDay;
}

double j2000_tai_seconds() {
  const double j2000_tt_seconds =
      static_cast<double>(days_from_civil(2000, 1, 1)) * kSecondsPerDay + 12.0 * 3600.0;
  return j2000_tt_seconds - kTtMinusTaiSeconds;
}

double tcg_offset_from_tai(double tai_seconds) {
  return kTtMinusTaiSeconds + kTcgLgRate * (tai_seconds - tcg_reference_tai_seconds());
}

double tai_seconds_from_tcg_local(double tcg_seconds) {
  const double reference = tcg_reference_tai_seconds();
  return (tcg_seconds - kTtMinusTaiSeconds + kTcgLgRate * reference) / (1.0 + kTcgLgRate);
}

double tdb_offset_from_tai(double tai_seconds) {
  const double dt_days = (tai_seconds - j2000_tai_seconds()) / kSecondsPerDay;
  const double g = kTdbG0Radians + kTdbG1RadiansPerDay * dt_days;
  const double sin_g = std::sin(g);
  const double cos_g = std::cos(g);
  return kTtMinusTaiSeconds + sin_g * (kTdbSinGFactorSeconds + kTdbTwoSin2GFactorSeconds * cos_g);
}

double tai_seconds_from_tdb_local(double tdb_seconds) {
  double tai_seconds = tdb_seconds - kTtMinusTaiSeconds;
  for (int index = 0; index < 5; ++index) {
    tai_seconds = tdb_seconds - tdb_offset_from_tai(tai_seconds);
  }
  return tai_seconds;
}

double tcb_offset_from_tai(double tai_seconds) {
  return tdb_offset_from_tai(tai_seconds) + kTcbLbRate * (tai_seconds - tcg_reference_tai_seconds());
}

double tai_seconds_from_tcb_local(double tcb_seconds) {
  double tai_seconds = tcb_seconds - kTtMinusTaiSeconds;
  for (int index = 0; index < 6; ++index) {
    tai_seconds = tcb_seconds - tcb_offset_from_tai(tai_seconds);
  }
  return tai_seconds;
}

double normalize_sidereal_offset(double seconds) {
  double normalized = std::fmod(seconds + kHalfDaySeconds, kSecondsPerDay);
  if (normalized < 0.0) {
    normalized += kSecondsPerDay;
  }
  return normalized - kHalfDaySeconds;
}

double gmst_reference_ut1_seconds() {
  return static_cast<double>(days_from_civil(2000, 1, 1)) * kSecondsPerDay + 12.0 * 3600.0;
}

double gmst_offset_from_tai(double tai_seconds, const TIMConversionRequest* request) {
  const double offset = tai_minus_utc_for_tai_seconds(tai_seconds);
  const double dut1 = request != nullptr && request->HAS_DUT1() ? request->DUT1_SECONDS() : 0.0;
  const double ut1_offset = -offset + dut1;
  const double ut1_seconds = tai_seconds + ut1_offset;
  const double tc = (ut1_seconds - gmst_reference_ut1_seconds()) / kJulianCenturySeconds;
  const double gmst0h = kGmstC0Seconds + tc * (kGmstC1Seconds + tc * (kGmstC2Seconds + tc * kGmstC3Seconds));
  return normalize_sidereal_offset(gmst0h + ut1_offset);
}

double tai_seconds_from_gmst_local(double gmst_seconds, const TIMConversionRequest* request) {
  double tai_seconds = gmst_seconds;
  for (int index = 0; index < 8; ++index) {
    tai_seconds = gmst_seconds - gmst_offset_from_tai(tai_seconds, request);
  }
  return tai_seconds;
}

bool source_local_seconds(
    const TIMInstant* source,
    const TIMConversionRequest* request,
    double* local_seconds,
    bool* utc_leap_second,
    bool* has_source_offset_override,
    double* source_offset_override) {
  if (source == nullptr || local_seconds == nullptr) {
    return false;
  }
  if (utc_leap_second != nullptr) {
    *utc_leap_second = false;
  }
  if (has_source_offset_override != nullptr) {
    *has_source_offset_override = false;
  }
  if (source_offset_override != nullptr) {
    *source_offset_override = 0.0;
  }
  switch (source->EPOCH_FORMAT()) {
    case timEpochRepresentation_ISO8601: {
      DateTime parsed;
      if (!parse_iso8601(source->ISO8601() ? source->ISO8601()->c_str() : nullptr, &parsed)) {
        return false;
      }
      if (parsed.leap_second && !scale_uses_utc_leap_labels(source->TIME_SYSTEM())) {
        return false;
      }
      if (parsed.large_leap_second) {
        if (source->TIME_SYSTEM() != timingStandard_UTC) {
          return false;
        }
        if (has_source_offset_override != nullptr) {
          *has_source_offset_override = true;
        }
        if (source_offset_override != nullptr) {
          *source_offset_override = -tai_minus_utc_for_utc_components(parsed);
        }
      }
      if (utc_leap_second != nullptr) {
        *utc_leap_second = parsed.leap_second;
      }
      *local_seconds = unix_seconds_from_datetime(parsed) - parsed.utc_offset_minutes * 60.0;
      return true;
    }
    case timEpochRepresentation_UNIX_SECONDS:
      *local_seconds = source->SECONDS();
      return std::isfinite(*local_seconds);
    case timEpochRepresentation_GPS_SECONDS:
      if (!supports_gnss_seconds_representation(source->TIME_SYSTEM())) {
        return false;
      }
      *local_seconds = gnss_seconds_epoch_for_scale(source->TIME_SYSTEM()) + source->SECONDS();
      return std::isfinite(*local_seconds);
    case timEpochRepresentation_GNSS_WEEK_SECONDS: {
      if (!supports_gnss_seconds_representation(source->TIME_SYSTEM())) {
        return false;
      }
      const int32_t week = source->GNSS_WEEK();
      const double seconds_in_week = source->SECONDS();
      if (week < 0 ||
          !std::isfinite(seconds_in_week) ||
          seconds_in_week < 0.0 ||
          seconds_in_week >= kSecondsPerWeek) {
        return false;
      }

      const int cycle_weeks = gnss_rollover_cycle_weeks(source->TIME_SYSTEM());
      double candidate =
          gnss_seconds_epoch_for_scale(source->TIME_SYSTEM()) +
          static_cast<double>(week) * kSecondsPerWeek +
          seconds_in_week;
      if (cycle_weeks > 0 && week < cycle_weeks && source->HAS_GNSS_ROLLOVER_REFERENCE()) {
        DateTime reference;
        const char* reference_text = source->GNSS_ROLLOVER_REFERENCE_ISO8601()
                                         ? source->GNSS_ROLLOVER_REFERENCE_ISO8601()->c_str()
                                         : nullptr;
        if (!parse_iso8601(reference_text, &reference)) {
          return false;
        }
        const double reference_seconds =
            unix_seconds_from_datetime(reference) - reference.utc_offset_minutes * 60.0;
        const double half_cycle_seconds = static_cast<double>(cycle_weeks) * kSecondsPerWeek / 2.0;
        const double cycle_seconds = static_cast<double>(cycle_weeks) * kSecondsPerWeek;
        while (candidate < reference_seconds - half_cycle_seconds) {
          candidate += cycle_seconds;
        }
      }

      *local_seconds = candidate;
      return std::isfinite(*local_seconds);
    }
    case timEpochRepresentation_CCSDS_TIME_CODE: {
      const TIMCcsdsTimeCode* code = source->CCSDS_TIME_CODE();
      if (code == nullptr) {
        return false;
      }

      if (code->CODE_KIND() == timCcsdsTimeCodeKind_DAY_SEGMENTED) {
        if (source->TIME_SYSTEM() != timingStandard_UTC) {
          return false;
        }
        const int preamble = static_cast<int>(code->PREAMBLE_FIELD1());
        if ((preamble & 0xF0) != 0x40) {
          return false;
        }

        double epoch_seconds = 0.0;
        if ((preamble & 0x08) == 0x00) {
          epoch_seconds = local_epoch_seconds(1958, 1, 1);
        } else {
          const char* epoch_text = code->AGENCY_DEFINED_EPOCH_ISO8601()
                                       ? code->AGENCY_DEFINED_EPOCH_ISO8601()->c_str()
                                       : nullptr;
          DateTime epoch;
          if (!parse_iso8601(epoch_text, &epoch)) {
            return false;
          }
          epoch_seconds = local_epoch_seconds(epoch.year, epoch.month, epoch.day);
        }

        const int day_segment_octets = (preamble & 0x04) == 0x00 ? 2 : 3;
        const int submillisecond_octets = (preamble & 0x03) << 1;
        if (submillisecond_octets == 6) {
          return false;
        }
        const ::flatbuffers::Vector<uint8_t>* time_field = code->TIME_FIELD();
        const int expected_octets = day_segment_octets + 4 + submillisecond_octets;
        if (time_field == nullptr ||
            time_field->size() != static_cast<::flatbuffers::uoffset_t>(expected_octets)) {
          return false;
        }

        int index = 0;
        int days = 0;
        while (index < day_segment_octets) {
          days = days * 256 + static_cast<int>(time_field->Get(index++));
        }

        uint64_t milliseconds_in_day = 0;
        while (index < day_segment_octets + 4) {
          milliseconds_in_day = milliseconds_in_day * 256U + static_cast<uint64_t>(time_field->Get(index++));
        }
        if (milliseconds_in_day >= static_cast<uint64_t>(kSecondsPerDay * 1000.0)) {
          return false;
        }

        uint64_t submillisecond = 0;
        while (index < expected_octets) {
          submillisecond = submillisecond * 256U + static_cast<uint64_t>(time_field->Get(index++));
        }

        double submillisecond_seconds = 0.0;
        if (submillisecond_octets == 2) {
          submillisecond_seconds = static_cast<double>(submillisecond) / 1000000.0;
        } else if (submillisecond_octets == 4) {
          submillisecond_seconds = static_cast<double>(submillisecond) / 1000000000000.0;
        }

        *local_seconds = epoch_seconds +
                         static_cast<double>(days) * kSecondsPerDay +
                         static_cast<double>(milliseconds_in_day) / 1000.0 +
                         submillisecond_seconds;
        return std::isfinite(*local_seconds);
      }

      if (code->CODE_KIND() == timCcsdsTimeCodeKind_CALENDAR_SEGMENTED) {
        if (source->TIME_SYSTEM() != timingStandard_UTC) {
          return false;
        }
        const int preamble = static_cast<int>(code->PREAMBLE_FIELD1());
        if ((preamble & 0xF0) != 0x50) {
          return false;
        }
        const int expected_octets = 7 + (preamble & 0x07);
        if (expected_octets == 14) {
          return false;
        }
        const ::flatbuffers::Vector<uint8_t>* time_field = code->TIME_FIELD();
        if (time_field == nullptr ||
            time_field->size() != static_cast<::flatbuffers::uoffset_t>(expected_octets)) {
          return false;
        }

        const int year = static_cast<int>(time_field->Get(0)) * 256 + static_cast<int>(time_field->Get(1));
        double date_seconds = 0.0;
        if ((preamble & 0x08) == 0x00) {
          const int month = static_cast<int>(time_field->Get(2));
          const int day = static_cast<int>(time_field->Get(3));
          if (!valid_civil_date(year, month, day)) {
            return false;
          }
          date_seconds = local_epoch_seconds(year, month, day);
        } else {
          const int day_of_year =
              static_cast<int>(time_field->Get(2)) * 256 + static_cast<int>(time_field->Get(3));
          const int64_t first_day = days_from_civil(year, 1, 1);
          const int64_t next_first_day = days_from_civil(year + 1, 1, 1);
          if (day_of_year < 1 || day_of_year > next_first_day - first_day) {
            return false;
          }
          date_seconds = static_cast<double>(first_day + day_of_year - 1) * kSecondsPerDay;
        }

        const int hour = static_cast<int>(time_field->Get(4));
        const int minute = static_cast<int>(time_field->Get(5));
        const int second = static_cast<int>(time_field->Get(6));
        if (hour > 23 || minute > 59 || second > 60) {
          return false;
        }
        if (second == 60 && utc_leap_second != nullptr) {
          *utc_leap_second = true;
        }

        double fractional_seconds = 0.0;
        double multiplier = 0.01;
        for (int index = 7; index < expected_octets; ++index) {
          fractional_seconds += static_cast<double>(time_field->Get(index)) * multiplier;
          multiplier /= 100.0;
        }

        *local_seconds = date_seconds +
                         static_cast<double>(hour * 3600 + minute * 60 + second) +
                         fractional_seconds;
        return std::isfinite(*local_seconds);
      }

      if (source->TIME_SYSTEM() != timingStandard_TAI ||
          code->CODE_KIND() != timCcsdsTimeCodeKind_UNSEGMENTED) {
        return false;
      }

      const int preamble1 = static_cast<int>(code->PREAMBLE_FIELD1());
      const int preamble2 = static_cast<int>(code->PREAMBLE_FIELD2());
      const int epoch_kind = preamble1 & kCcsdsUnsegmentedEpochMask;
      double epoch_seconds = 0.0;
      if (epoch_kind == kCcsdsUnsegmentedCcsdsEpoch) {
        const char* epoch_text = code->CCSDS_EPOCH_ISO8601()
                                     ? code->CCSDS_EPOCH_ISO8601()->c_str()
                                     : nullptr;
        if (epoch_text != nullptr) {
          DateTime epoch;
          if (!parse_iso8601(epoch_text, &epoch)) {
            return false;
          }
          epoch_seconds = unix_seconds_from_datetime(epoch) - epoch.utc_offset_minutes * 60.0;
        } else {
          epoch_seconds = ccsds_epoch_tai_seconds();
        }
      } else if (epoch_kind == kCcsdsUnsegmentedAgencyEpoch) {
        const char* epoch_text = code->AGENCY_DEFINED_EPOCH_ISO8601()
                                     ? code->AGENCY_DEFINED_EPOCH_ISO8601()->c_str()
                                     : nullptr;
        DateTime epoch;
        if (!parse_iso8601(epoch_text, &epoch)) {
          return false;
        }
        epoch_seconds = unix_seconds_from_datetime(epoch) - epoch.utc_offset_minutes * 60.0;
      } else {
        return false;
      }

      int coarse_octets = 1 + ((preamble1 & 0x0C) >> 2);
      int fine_octets = preamble1 & 0x03;
      if ((preamble1 & 0x80) != 0) {
        coarse_octets += (preamble2 & 0x60) >> 5;
        fine_octets += (preamble2 & 0x1C) >> 2;
      }

      const ::flatbuffers::Vector<uint8_t>* time_field = code->TIME_FIELD();
      if (time_field == nullptr ||
          coarse_octets < 1 ||
          fine_octets < 0 ||
          time_field->size() != static_cast<::flatbuffers::uoffset_t>(coarse_octets + fine_octets)) {
        return false;
      }

      double seconds = 0.0;
      for (int index = 0; index < coarse_octets; ++index) {
        seconds = seconds * 256.0 + static_cast<double>(time_field->Get(index));
      }
      double denominator = 256.0;
      for (int index = 0; index < fine_octets; ++index) {
        seconds += static_cast<double>(time_field->Get(coarse_octets + index)) / denominator;
        denominator *= 256.0;
      }

      *local_seconds = epoch_seconds + seconds;
      return std::isfinite(*local_seconds);
    }
    case timEpochRepresentation_JULIAN_DATE:
      *local_seconds = (source->JULIAN_DATE() - kJulianDateUnixEpoch) * kSecondsPerDay;
      return std::isfinite(*local_seconds);
    case timEpochRepresentation_MODIFIED_JULIAN_DATE:
      *local_seconds = (source->JULIAN_DATE() + kModifiedJulianDateOffset - kJulianDateUnixEpoch) * kSecondsPerDay;
      return std::isfinite(*local_seconds);
    default:
      (void)request;
      return false;
  }
}

double offset_from_tai_for_local(
    timingStandard scale,
    double local_seconds,
    const TIMConversionRequest* request,
    bool utc_leap_second,
    bool has_source_offset_override,
    double source_offset_override) {
  if (scale == timingStandard_UTC) {
    if (request != nullptr && request->HAS_TAI_MINUS_UTC()) {
      return -request->TAI_MINUS_UTC_SECONDS();
    }
    if (has_source_offset_override) {
      return source_offset_override;
    }
    if (utc_leap_second) {
      return -tai_minus_utc_for_utc_seconds(local_seconds - 1.0);
    }
    return -tai_minus_utc_for_utc_seconds(local_seconds);
  }
  if (scale == timingStandard_UT1) {
    const double utc_offset = -tai_minus_utc_for_utc_seconds(local_seconds);
    return utc_offset + (request != nullptr && request->HAS_DUT1() ? request->DUT1_SECONDS() : 0.0);
  }
  if (scale == timingStandard_GLONASS) {
    return glonass_offset_from_tai_for_local(local_seconds, request, utc_leap_second);
  }
  if (scale == timingStandard_TCG) {
    const double tai_seconds = tai_seconds_from_tcg_local(local_seconds);
    return tcg_offset_from_tai(tai_seconds);
  }
  if (scale == timingStandard_TDB) {
    const double tai_seconds = tai_seconds_from_tdb_local(local_seconds);
    return tdb_offset_from_tai(tai_seconds);
  }
  if (scale == timingStandard_TCB) {
    const double tai_seconds = tai_seconds_from_tcb_local(local_seconds);
    return tcb_offset_from_tai(tai_seconds);
  }
  if (scale == timingStandard_GMST) {
    const double tai_seconds = tai_seconds_from_gmst_local(local_seconds, request);
    return gmst_offset_from_tai(tai_seconds, request);
  }
  return constant_offset_from_tai(scale);
}

double target_local_from_tai(
    timingStandard scale,
    double tai_seconds,
    const TIMConversionRequest* request,
    bool* utc_leap_second) {
  if (utc_leap_second != nullptr) {
    *utc_leap_second = false;
  }
  if (scale == timingStandard_UTC) {
    double leap_utc_seconds = 0.0;
    if (utc_leap_second_from_tai(tai_seconds, &leap_utc_seconds, nullptr)) {
      if (utc_leap_second != nullptr) {
        *utc_leap_second = true;
      }
      return leap_utc_seconds;
    }
    const double offset = request != nullptr && request->HAS_TAI_MINUS_UTC()
                           ? request->TAI_MINUS_UTC_SECONDS()
                           : tai_minus_utc_for_tai_seconds(tai_seconds);
    return tai_seconds - offset;
  }
  if (scale == timingStandard_UT1) {
    const double offset = tai_minus_utc_for_tai_seconds(tai_seconds);
    const double dut1 = request != nullptr && request->HAS_DUT1() ? request->DUT1_SECONDS() : 0.0;
    return tai_seconds - offset + dut1;
  }
  if (scale == timingStandard_GLONASS) {
    double leap_utc_seconds = 0.0;
    if (utc_leap_second_from_tai(tai_seconds, &leap_utc_seconds, nullptr)) {
      if (utc_leap_second != nullptr) {
        *utc_leap_second = true;
      }
      return leap_utc_seconds + kGlonassMinusUtcSeconds;
    }
    return tai_seconds + glonass_offset_from_tai_for_tai(tai_seconds, request);
  }
  if (scale == timingStandard_TCG) {
    return tai_seconds + tcg_offset_from_tai(tai_seconds);
  }
  if (scale == timingStandard_TDB) {
    return tai_seconds + tdb_offset_from_tai(tai_seconds);
  }
  if (scale == timingStandard_TCB) {
    return tai_seconds + tcb_offset_from_tai(tai_seconds);
  }
  if (scale == timingStandard_GMST) {
    return tai_seconds + gmst_offset_from_tai(tai_seconds, request);
  }
  return tai_seconds + constant_offset_from_tai(scale);
}

double offset_from_tai_for_target(timingStandard scale, double tai_seconds, const TIMConversionRequest* request) {
  if (scale == timingStandard_UTC) {
    int leap_offset = 0;
    if (utc_leap_second_from_tai(tai_seconds, nullptr, &leap_offset)) {
      return -static_cast<double>(leap_offset);
    }
    const double offset = request != nullptr && request->HAS_TAI_MINUS_UTC()
                           ? request->TAI_MINUS_UTC_SECONDS()
                           : tai_minus_utc_for_tai_seconds(tai_seconds);
    return -offset;
  }
  if (scale == timingStandard_UT1) {
    const double offset = tai_minus_utc_for_tai_seconds(tai_seconds);
    const double dut1 = request != nullptr && request->HAS_DUT1() ? request->DUT1_SECONDS() : 0.0;
    return -offset + dut1;
  }
  if (scale == timingStandard_GLONASS) {
    return glonass_offset_from_tai_for_tai(tai_seconds, request);
  }
  if (scale == timingStandard_TCG) {
    return tcg_offset_from_tai(tai_seconds);
  }
  if (scale == timingStandard_TDB) {
    return tdb_offset_from_tai(tai_seconds);
  }
  if (scale == timingStandard_TCB) {
    return tcb_offset_from_tai(tai_seconds);
  }
  if (scale == timingStandard_GMST) {
    return gmst_offset_from_tai(tai_seconds, request);
  }
  return constant_offset_from_tai(scale);
}

std::string format_for_scale(timingStandard scale, double local_seconds, bool utc_leap_second) {
  return format_iso8601(
      local_seconds,
      scale == timingStandard_UTC,
      scale_uses_utc_leap_labels(scale) && utc_leap_second);
}

double julian_field_for_format(timEpochRepresentation format, double local_seconds) {
  const double jd = (local_seconds / kSecondsPerDay) + kJulianDateUnixEpoch;
  switch (format) {
    case timEpochRepresentation_JULIAN_DATE:
      return jd;
    case timEpochRepresentation_MODIFIED_JULIAN_DATE:
      return jd - kModifiedJulianDateOffset;
    default:
      return 0.0;
  }
}

double seconds_field_for_format(
    timEpochRepresentation format,
    timingStandard scale,
    double local_seconds) {
  switch (format) {
    case timEpochRepresentation_UNIX_SECONDS:
      return local_seconds;
    case timEpochRepresentation_GPS_SECONDS:
      return local_seconds - gnss_seconds_epoch_for_scale(scale);
    case timEpochRepresentation_GNSS_WEEK_SECONDS: {
      const double elapsed = local_seconds - gnss_seconds_epoch_for_scale(scale);
      const double week = std::floor(elapsed / kSecondsPerWeek);
      double seconds = elapsed - week * kSecondsPerWeek;
      if (seconds < 0.0) {
        seconds += kSecondsPerWeek;
      }
      if (std::abs(seconds - kSecondsPerWeek) <= 1e-9) {
        return 0.0;
      }
      return seconds;
    }
    default:
      return 0.0;
  }
}

int32_t gnss_week_field_for_format(
    timEpochRepresentation format,
    timingStandard scale,
    double local_seconds) {
  if (format != timEpochRepresentation_GNSS_WEEK_SECONDS) {
    return 0;
  }
  const double elapsed = local_seconds - gnss_seconds_epoch_for_scale(scale);
  return static_cast<int32_t>(std::floor(elapsed / kSecondsPerWeek));
}

__int128 total_microseconds_from_datetime(const DateTime& value) {
  const int64_t days = days_from_civil(
      value.year,
      static_cast<unsigned>(value.month),
      static_cast<unsigned>(value.day));
  return static_cast<__int128>(days) * 86400 * 1000000 +
         static_cast<__int128>(value.hour) * 3600 * 1000000 +
         static_cast<__int128>(value.minute) * 60 * 1000000 +
         static_cast<__int128>(value.second) * 1000000 +
         static_cast<__int128>(value.microsecond);
}

bool target_cuc_time_field_from_tai_epoch_seconds(
    double target_local_seconds,
    double epoch_seconds,
    int coarse_octets,
    int fine_octets,
    std::vector<uint8_t>* out) {
  if (!std::isfinite(target_local_seconds) || out == nullptr) {
    return false;
  }
  if (!std::isfinite(epoch_seconds) ||
      coarse_octets < 1 ||
      coarse_octets > 7 ||
      fine_octets < 0 ||
      fine_octets > 10) {
    return false;
  }

  const DateTime target = datetime_from_unix_seconds(target_local_seconds);
  const DateTime epoch = datetime_from_unix_seconds(epoch_seconds);
  if (target.microsecond < 0 || target.microsecond >= 1000000 ||
      epoch.microsecond < 0 || epoch.microsecond >= 1000000) {
    return false;
  }

  const __int128 delta_microseconds_signed =
      total_microseconds_from_datetime(target) - total_microseconds_from_datetime(epoch);
  if (delta_microseconds_signed < 0) {
    return false;
  }
  const __uint128_t delta_microseconds = static_cast<__uint128_t>(delta_microseconds_signed);
  const __uint128_t coarse_seconds = delta_microseconds / 1000000U;
  const __uint128_t residual_microseconds = delta_microseconds % 1000000U;
  const __uint128_t max_coarse_seconds = (static_cast<__uint128_t>(1) << (coarse_octets * 8)) - 1U;
  if (coarse_seconds > max_coarse_seconds) {
    return false;
  }

  __uint128_t fine = 0;
  if (fine_octets > 0) {
    const __uint128_t fine_scale = static_cast<__uint128_t>(1) << (fine_octets * 8);
    fine = residual_microseconds * fine_scale / 1000000U;
  }

  out->clear();
  out->reserve(static_cast<size_t>(coarse_octets + fine_octets));
  for (int shift = (coarse_octets - 1) * 8; shift >= 0; shift -= 8) {
    out->push_back(static_cast<uint8_t>((coarse_seconds >> shift) & 0xFFU));
  }
  for (int shift = (fine_octets - 1) * 8; shift >= 0; shift -= 8) {
    out->push_back(static_cast<uint8_t>((fine >> shift) & 0xFFU));
  }
  return true;
}

bool target_cuc_time_field_from_tai_seconds(double target_local_seconds, std::vector<uint8_t>* out) {
  return target_cuc_time_field_from_tai_epoch_seconds(
      target_local_seconds,
      ccsds_epoch_tai_seconds(),
      4,
      3,
      out);
}

bool target_cds_time_field_from_utc_epoch_day(
    double target_local_seconds,
    int64_t epoch_day,
    int day_segment_octets,
    int submillisecond_octets,
    std::vector<uint8_t>* out) {
  if (!std::isfinite(target_local_seconds) || out == nullptr) {
    return false;
  }
  if ((day_segment_octets != 2 && day_segment_octets != 3) ||
      (submillisecond_octets != 0 && submillisecond_octets != 2 && submillisecond_octets != 4)) {
    return false;
  }

  const DateTime target = datetime_from_unix_seconds(target_local_seconds);
  if (target.microsecond < 0 || target.microsecond >= 1000000) {
    return false;
  }

  const int64_t days =
      days_from_civil(target.year, static_cast<unsigned>(target.month), static_cast<unsigned>(target.day)) - epoch_day;
  const int64_t max_days = day_segment_octets == 2 ? 0xFFFFLL : 0xFFFFFFLL;
  if (days < 0 || days > max_days) {
    return false;
  }

  const uint32_t milliseconds_in_day =
      static_cast<uint32_t>((target.hour * 3600 + target.minute * 60 + target.second) * 1000 +
                            target.microsecond / 1000);
  if (milliseconds_in_day >= static_cast<uint32_t>(kSecondsPerDay * 1000.0)) {
    return false;
  }
  uint32_t submillisecond = 0;
  if (submillisecond_octets == 2) {
    submillisecond = static_cast<uint32_t>(target.microsecond % 1000);
  } else if (submillisecond_octets == 4) {
    submillisecond = static_cast<uint32_t>((target.microsecond % 1000) * 1000000);
  }

  out->clear();
  out->reserve(static_cast<size_t>(day_segment_octets + 4 + submillisecond_octets));
  for (int shift = (day_segment_octets - 1) * 8; shift >= 0; shift -= 8) {
    out->push_back(static_cast<uint8_t>((days >> shift) & 0xFFU));
  }
  out->push_back(static_cast<uint8_t>((milliseconds_in_day >> 24) & 0xFFU));
  out->push_back(static_cast<uint8_t>((milliseconds_in_day >> 16) & 0xFFU));
  out->push_back(static_cast<uint8_t>((milliseconds_in_day >> 8) & 0xFFU));
  out->push_back(static_cast<uint8_t>(milliseconds_in_day & 0xFFU));
  for (int shift = (submillisecond_octets - 1) * 8; shift >= 0; shift -= 8) {
    out->push_back(static_cast<uint8_t>((submillisecond >> shift) & 0xFFU));
  }
  return true;
}

bool target_cds_time_field_from_utc_seconds(double target_local_seconds, std::vector<uint8_t>* out) {
  return target_cds_time_field_from_utc_epoch_day(
      target_local_seconds,
      days_from_civil(1958, 1, 1),
      2,
      4,
      out);
}

bool target_tai_ccsds_time_field(
    const TIMInstant* source,
    double target_local_seconds,
    timCcsdsTimeCodeKind* target_kind,
    uint8_t* preamble1,
    uint8_t* preamble2,
    const char** agency_epoch_iso8601,
    const char** ccsds_epoch_iso8601,
    std::vector<uint8_t>* out) {
  if (agency_epoch_iso8601 != nullptr) {
    *agency_epoch_iso8601 = nullptr;
  }
  if (ccsds_epoch_iso8601 != nullptr) {
    *ccsds_epoch_iso8601 = nullptr;
  }
  if (source != nullptr && source->EPOCH_FORMAT() == timEpochRepresentation_CCSDS_TIME_CODE) {
    const TIMCcsdsTimeCode* code = source->CCSDS_TIME_CODE();
    if (code != nullptr && code->CODE_KIND() == timCcsdsTimeCodeKind_UNSEGMENTED) {
      const int source_preamble1 = static_cast<int>(code->PREAMBLE_FIELD1());
      const int source_preamble2 = static_cast<int>(code->PREAMBLE_FIELD2());
      const int epoch_kind = source_preamble1 & kCcsdsUnsegmentedEpochMask;
      double epoch_seconds = 0.0;
      const char* agency_epoch = nullptr;
      const char* ccsds_epoch = nullptr;
      if (epoch_kind == kCcsdsUnsegmentedCcsdsEpoch) {
        ccsds_epoch = code->CCSDS_EPOCH_ISO8601() ? code->CCSDS_EPOCH_ISO8601()->c_str() : nullptr;
        if (ccsds_epoch != nullptr) {
          DateTime epoch;
          if (!parse_iso8601(ccsds_epoch, &epoch)) {
            return false;
          }
          epoch_seconds = unix_seconds_from_datetime(epoch) - epoch.utc_offset_minutes * 60.0;
        } else {
          epoch_seconds = ccsds_epoch_tai_seconds();
        }
      } else if (epoch_kind == kCcsdsUnsegmentedAgencyEpoch) {
        agency_epoch = code->AGENCY_DEFINED_EPOCH_ISO8601()
                           ? code->AGENCY_DEFINED_EPOCH_ISO8601()->c_str()
                           : nullptr;
        DateTime epoch;
        if (!parse_iso8601(agency_epoch, &epoch)) {
          return false;
        }
        epoch_seconds = unix_seconds_from_datetime(epoch) - epoch.utc_offset_minutes * 60.0;
      } else {
        return false;
      }

      int coarse_octets = 1 + ((source_preamble1 & 0x0C) >> 2);
      int fine_octets = source_preamble1 & 0x03;
      if ((source_preamble1 & 0x80) != 0) {
        coarse_octets += (source_preamble2 & 0x60) >> 5;
        fine_octets += (source_preamble2 & 0x1C) >> 2;
      }
      const ::flatbuffers::Vector<uint8_t>* source_time_field = code->TIME_FIELD();
      const auto expected_source_octets =
          static_cast<::flatbuffers::uoffset_t>(coarse_octets + fine_octets);
      if (source->TIME_SYSTEM() == timingStandard_TAI &&
          source_time_field != nullptr &&
          source_time_field->size() == expected_source_octets) {
        out->clear();
        out->reserve(source_time_field->size());
        for (::flatbuffers::uoffset_t index = 0; index < source_time_field->size(); ++index) {
          out->push_back(source_time_field->Get(index));
        }
        *target_kind = timCcsdsTimeCodeKind_UNSEGMENTED;
        *preamble1 = static_cast<uint8_t>(source_preamble1);
        *preamble2 = static_cast<uint8_t>(source_preamble2);
        if (agency_epoch_iso8601 != nullptr) {
          *agency_epoch_iso8601 = agency_epoch;
        }
        if (ccsds_epoch_iso8601 != nullptr) {
          *ccsds_epoch_iso8601 = ccsds_epoch;
        }
        return true;
      }
      if (target_cuc_time_field_from_tai_epoch_seconds(
              target_local_seconds,
              epoch_seconds,
              coarse_octets,
              fine_octets,
              out)) {
        *target_kind = timCcsdsTimeCodeKind_UNSEGMENTED;
        *preamble1 = static_cast<uint8_t>(source_preamble1);
        *preamble2 = static_cast<uint8_t>(source_preamble2);
        if (agency_epoch_iso8601 != nullptr) {
          *agency_epoch_iso8601 = agency_epoch;
        }
        if (ccsds_epoch_iso8601 != nullptr) {
          *ccsds_epoch_iso8601 = ccsds_epoch;
        }
        return true;
      }
      return false;
    }
  }

  if (!target_cuc_time_field_from_tai_seconds(target_local_seconds, out)) {
    return false;
  }
  *target_kind = timCcsdsTimeCodeKind_UNSEGMENTED;
  *preamble1 = 0x1F;
  *preamble2 = 0x00;
  return true;
}

bool target_ccs_day_of_year_time_field_from_utc_seconds(double target_local_seconds, std::vector<uint8_t>* out) {
  if (!std::isfinite(target_local_seconds) || out == nullptr) {
    return false;
  }

  const DateTime target = datetime_from_unix_seconds(target_local_seconds);
  if (target.year < 0 || target.year > 0xFFFF ||
      target.hour < 0 || target.hour > 23 ||
      target.minute < 0 || target.minute > 59 ||
      target.second < 0 || target.second > 60 ||
      target.microsecond < 0 || target.microsecond >= 1000000) {
    return false;
  }

  const int64_t day =
      days_from_civil(target.year, static_cast<unsigned>(target.month), static_cast<unsigned>(target.day));
  const int64_t first_day = days_from_civil(target.year, 1, 1);
  const int64_t next_first_day = days_from_civil(target.year + 1, 1, 1);
  const int64_t day_of_year = day - first_day + 1;
  if (day_of_year < 1 || day_of_year > next_first_day - first_day || day_of_year > 0xFFFFLL) {
    return false;
  }

  const int fractional_hundredths = target.microsecond / 10000;
  const int fractional_ten_thousandths = (target.microsecond / 100) % 100;
  const int fractional_millionths = target.microsecond % 100;
  out->clear();
  out->reserve(10);
  out->push_back(static_cast<uint8_t>((target.year >> 8) & 0xFF));
  out->push_back(static_cast<uint8_t>(target.year & 0xFF));
  out->push_back(static_cast<uint8_t>((day_of_year >> 8) & 0xFF));
  out->push_back(static_cast<uint8_t>(day_of_year & 0xFF));
  out->push_back(static_cast<uint8_t>(target.hour));
  out->push_back(static_cast<uint8_t>(target.minute));
  out->push_back(static_cast<uint8_t>(target.second));
  out->push_back(static_cast<uint8_t>(fractional_hundredths));
  out->push_back(static_cast<uint8_t>(fractional_ten_thousandths));
  out->push_back(static_cast<uint8_t>(fractional_millionths));
  return true;
}

bool source_prefers_calendar_ccsds_target(const TIMInstant* source) {
  if (source == nullptr || source->EPOCH_FORMAT() != timEpochRepresentation_CCSDS_TIME_CODE) {
    return false;
  }
  const TIMCcsdsTimeCode* code = source->CCSDS_TIME_CODE();
  return code != nullptr && code->CODE_KIND() == timCcsdsTimeCodeKind_CALENDAR_SEGMENTED;
}

bool target_utc_ccsds_time_field(
    const TIMInstant* source,
    double target_local_seconds,
    timCcsdsTimeCodeKind* target_kind,
    uint8_t* preamble1,
    const char** agency_epoch_iso8601,
    std::vector<uint8_t>* out) {
  if (agency_epoch_iso8601 != nullptr) {
    *agency_epoch_iso8601 = nullptr;
  }
  if (source != nullptr && source->EPOCH_FORMAT() == timEpochRepresentation_CCSDS_TIME_CODE) {
    const TIMCcsdsTimeCode* code = source->CCSDS_TIME_CODE();
    if (code != nullptr && code->CODE_KIND() == timCcsdsTimeCodeKind_DAY_SEGMENTED) {
      const int source_preamble = static_cast<int>(code->PREAMBLE_FIELD1());
      if ((source_preamble & 0xF0) == 0x40) {
        int64_t epoch_day = days_from_civil(1958, 1, 1);
        const char* agency_epoch = nullptr;
        if ((source_preamble & 0x08) != 0) {
          agency_epoch = code->AGENCY_DEFINED_EPOCH_ISO8601()
                             ? code->AGENCY_DEFINED_EPOCH_ISO8601()->c_str()
                             : nullptr;
          DateTime parsed_epoch;
          if (!parse_iso8601(agency_epoch, &parsed_epoch)) {
            return false;
          }
          epoch_day = days_from_civil(
              parsed_epoch.year,
              static_cast<unsigned>(parsed_epoch.month),
              static_cast<unsigned>(parsed_epoch.day));
        }
        const int day_segment_octets = (source_preamble & 0x04) == 0x00 ? 2 : 3;
        const int submillisecond_octets = (source_preamble & 0x03) << 1;
        const ::flatbuffers::Vector<uint8_t>* source_time_field = code->TIME_FIELD();
        const auto expected_source_octets =
            static_cast<::flatbuffers::uoffset_t>(day_segment_octets + 4 + submillisecond_octets);
        if (source->TIME_SYSTEM() == timingStandard_UTC &&
            source_time_field != nullptr &&
            source_time_field->size() == expected_source_octets) {
          out->clear();
          out->reserve(source_time_field->size());
          for (::flatbuffers::uoffset_t index = 0; index < source_time_field->size(); ++index) {
            out->push_back(source_time_field->Get(index));
          }
          *target_kind = timCcsdsTimeCodeKind_DAY_SEGMENTED;
          *preamble1 = static_cast<uint8_t>(source_preamble);
          if (agency_epoch_iso8601 != nullptr) {
            *agency_epoch_iso8601 = agency_epoch;
          }
          return true;
        }
        if (target_cds_time_field_from_utc_epoch_day(
                target_local_seconds,
                epoch_day,
                day_segment_octets,
                submillisecond_octets,
                out)) {
          *target_kind = timCcsdsTimeCodeKind_DAY_SEGMENTED;
          *preamble1 = static_cast<uint8_t>(source_preamble);
          if (agency_epoch_iso8601 != nullptr) {
            *agency_epoch_iso8601 = agency_epoch;
          }
          return true;
        }
        return false;
      }
    }
    if (code != nullptr && code->CODE_KIND() == timCcsdsTimeCodeKind_CALENDAR_SEGMENTED) {
      const int source_preamble = static_cast<int>(code->PREAMBLE_FIELD1());
      const int expected_octets = 7 + (source_preamble & 0x07);
      const ::flatbuffers::Vector<uint8_t>* source_time_field = code->TIME_FIELD();
      if (source->TIME_SYSTEM() == timingStandard_UTC &&
          (source_preamble & 0xF0) == 0x50 &&
          expected_octets != 14 &&
          source_time_field != nullptr &&
          source_time_field->size() == static_cast<::flatbuffers::uoffset_t>(expected_octets)) {
        out->clear();
        out->reserve(source_time_field->size());
        for (::flatbuffers::uoffset_t index = 0; index < source_time_field->size(); ++index) {
          out->push_back(source_time_field->Get(index));
        }
        *target_kind = timCcsdsTimeCodeKind_CALENDAR_SEGMENTED;
        *preamble1 = static_cast<uint8_t>(source_preamble);
        return true;
      }
    }
  }

  if (source_prefers_calendar_ccsds_target(source)) {
    if (!target_ccs_day_of_year_time_field_from_utc_seconds(target_local_seconds, out)) {
      return false;
    }
    *target_kind = timCcsdsTimeCodeKind_CALENDAR_SEGMENTED;
    *preamble1 = 0x5B;
    return true;
  }

  if (!target_cds_time_field_from_utc_seconds(target_local_seconds, out)) {
    return false;
  }
  *target_kind = timCcsdsTimeCodeKind_DAY_SEGMENTED;
  *preamble1 = 0x42;
  return true;
}

::flatbuffers::Offset<TIMCcsdsTimeCode> copy_ccsds_time_code(
    ::flatbuffers::FlatBufferBuilder& builder,
    const TIMCcsdsTimeCode* code) {
  if (code == nullptr) {
    return 0;
  }
  std::vector<uint8_t> time_field;
  const ::flatbuffers::Vector<uint8_t>* source_time_field = code->TIME_FIELD();
  if (source_time_field != nullptr) {
    time_field.reserve(source_time_field->size());
    for (::flatbuffers::uoffset_t index = 0; index < source_time_field->size(); ++index) {
      time_field.push_back(source_time_field->Get(index));
    }
  }
  const char* agency_epoch = code->AGENCY_DEFINED_EPOCH_ISO8601()
                                 ? code->AGENCY_DEFINED_EPOCH_ISO8601()->c_str()
                                 : nullptr;
  const char* ccsds_epoch = code->CCSDS_EPOCH_ISO8601()
                                ? code->CCSDS_EPOCH_ISO8601()->c_str()
                                : nullptr;
  return CreateTIMCcsdsTimeCodeDirect(
      builder,
      code->CODE_KIND(),
      code->PREAMBLE_FIELD1(),
      code->PREAMBLE_FIELD2(),
      &time_field,
      agency_epoch,
      ccsds_epoch);
}

::flatbuffers::Offset<TIMInstant> copy_source_instant(
    ::flatbuffers::FlatBufferBuilder& builder,
    const TIMInstant* source) {
  const char* iso = source && source->ISO8601() ? source->ISO8601()->c_str() : nullptr;
  const char* label = source && source->EPOCH_LABEL() ? source->EPOCH_LABEL()->c_str() : nullptr;
  const char* gnss_rollover_reference =
      source && source->GNSS_ROLLOVER_REFERENCE_ISO8601()
          ? source->GNSS_ROLLOVER_REFERENCE_ISO8601()->c_str()
          : nullptr;
  const auto ccsds_time_code = copy_ccsds_time_code(
      builder,
      source ? source->CCSDS_TIME_CODE() : nullptr);
  return CreateTIMInstantDirect(
      builder,
      source ? source->TIME_SYSTEM() : timingStandard_GMST,
      source ? source->EPOCH_FORMAT() : timEpochRepresentation_ISO8601,
      source ? source->JULIAN_DATE() : 0.0,
      source ? source->SECONDS() : 0.0,
      iso,
      source ? source->SUBSECOND_NANOS() : 0,
      label,
      source ? source->GNSS_WEEK() : 0,
      source ? source->HAS_GNSS_ROLLOVER_REFERENCE() : false,
      gnss_rollover_reference,
      ccsds_time_code);
}

int emit_result(
    const TIMInstant* source,
    timingStandard target_scale,
    timEpochRepresentation target_format,
    double target_local_seconds,
    double delta_seconds,
    bool target_utc_leap_second,
    timConversionStatus status,
    const char* error_message,
    const char* trace_id) {
  ::flatbuffers::FlatBufferBuilder builder(512);
  const auto source_offset = copy_source_instant(builder, source);
  const std::string target_iso = status == timConversionStatus_OK
                                     ? format_for_scale(target_scale, target_local_seconds, target_utc_leap_second)
                                     : "";
  const double target_julian = status == timConversionStatus_OK
                                   ? julian_field_for_format(target_format, target_local_seconds)
                                   : 0.0;
  const double target_seconds = status == timConversionStatus_OK
                                    ? seconds_field_for_format(target_format, target_scale, target_local_seconds)
                                    : 0.0;
  const int32_t target_gnss_week = status == timConversionStatus_OK
                                       ? gnss_week_field_for_format(target_format, target_scale, target_local_seconds)
                                       : 0;
  std::vector<uint8_t> target_ccsds_time_field;
  ::flatbuffers::Offset<TIMCcsdsTimeCode> target_ccsds_time_code = 0;
  if (status == timConversionStatus_OK &&
      target_format == timEpochRepresentation_CCSDS_TIME_CODE) {
    if (target_scale == timingStandard_TAI) {
      timCcsdsTimeCodeKind target_kind = timCcsdsTimeCodeKind_NONE;
      uint8_t preamble1 = 0;
      uint8_t preamble2 = 0;
      const char* agency_epoch = nullptr;
      const char* ccsds_epoch = nullptr;
      if (target_tai_ccsds_time_field(
              source,
              target_local_seconds,
              &target_kind,
              &preamble1,
              &preamble2,
              &agency_epoch,
              &ccsds_epoch,
              &target_ccsds_time_field)) {
        target_ccsds_time_code = CreateTIMCcsdsTimeCodeDirect(
            builder,
            target_kind,
            preamble1,
            preamble2,
            &target_ccsds_time_field,
            agency_epoch,
            ccsds_epoch);
      }
    } else if (target_scale == timingStandard_UTC) {
      timCcsdsTimeCodeKind target_kind = timCcsdsTimeCodeKind_NONE;
      uint8_t preamble1 = 0;
      const char* agency_epoch = nullptr;
      if (target_utc_ccsds_time_field(
              source,
              target_local_seconds,
              &target_kind,
              &preamble1,
              &agency_epoch,
              &target_ccsds_time_field)) {
        target_ccsds_time_code = CreateTIMCcsdsTimeCodeDirect(
            builder,
            target_kind,
            preamble1,
            0x00,
            &target_ccsds_time_field,
            agency_epoch);
      }
    }
  }
  const auto target_offset = CreateTIMInstantDirect(
      builder,
      target_scale,
      target_format,
      target_julian,
      target_seconds,
      target_iso.empty() ? nullptr : target_iso.c_str(),
      0,
      nullptr,
      target_gnss_week,
      false,
      nullptr,
      target_ccsds_time_code);
  const auto result = CreateTIMConversionResultDirect(
      builder,
      source_offset,
      target_offset,
      delta_seconds,
      status,
      error_message,
      trace_id);
  const auto envelope = CreateTIM(builder, target_scale, 0, 0, result);
  FinishTIMBuffer(builder, envelope);

  if (plugin_push_output(
          "result",
          "TIM.fbs",
          "$TIM",
          builder.GetBufferPointer(),
          static_cast<uint32_t>(builder.GetSize())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit TIM conversion result.");
    return 1;
  }
  return 0;
}

int emit_request_error(
    const TIMConversionRequest* request,
    timConversionStatus status,
    const char* message) {
  const TIMInstant* source = request ? request->SOURCE() : nullptr;
  const timingStandard target = request ? request->TARGET_TIME_SYSTEM() : timingStandard_GMST;
  const timEpochRepresentation format =
      request ? request->TARGET_EPOCH_FORMAT() : timEpochRepresentation_ISO8601;
  const char* trace = request && request->TRACE_ID() ? request->TRACE_ID()->c_str() : nullptr;
  return emit_result(source, target, format, 0.0, 0.0, false, status, message, trace);
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

extern "C" int convert_time(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* frame = find_request_frame();
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length == 0) {
    plugin_set_error("missing-request", "No TIM conversion request frame was provided.");
    return 3;
  }
  if (!TIMBufferHasIdentifier(frame->payload)) {
    plugin_set_error("invalid-request-buffer", "Input is not an SDS TIM FlatBuffer.");
    return 3;
  }

  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyTIMBuffer(verifier)) {
    plugin_set_error("invalid-request-buffer", "Input is not a valid SDS TIM FlatBuffer.");
    return 3;
  }

  const TIM* envelope = GetTIM(frame->payload);
  const TIMConversionRequest* request = envelope ? envelope->CONVERSION_REQUEST() : nullptr;
  const TIMInstant* source = request ? request->SOURCE() : nullptr;
  if (request == nullptr || source == nullptr) {
    plugin_set_error("missing-conversion-request", "TIM envelope must carry TIMConversionRequest.SOURCE.");
    return 3;
  }

  const timingStandard source_scale = source->TIME_SYSTEM();
  const timingStandard target_scale = request->TARGET_TIME_SYSTEM();
  const char* trace = request->TRACE_ID() ? request->TRACE_ID()->c_str() : nullptr;

  if ((source_scale == timingStandard_UT1 || target_scale == timingStandard_UT1) && !request->HAS_DUT1()) {
    return emit_request_error(request, timConversionStatus_EOP_DATA_REQUIRED, "UT1 conversion requires DUT1_SECONDS.");
  }
  if ((source_scale == timingStandard_GMST || target_scale == timingStandard_GMST) && !request->HAS_DUT1()) {
    return emit_request_error(request, timConversionStatus_EOP_DATA_REQUIRED, "GMST conversion requires DUT1_SECONDS.");
  }
  if (!supported_without_eop(source_scale) && source_scale != timingStandard_UT1) {
    return emit_request_error(request, timConversionStatus_UNSUPPORTED_TIME_SYSTEM, "Source time system is not supported.");
  }
  if (!supported_without_eop(target_scale) && target_scale != timingStandard_UT1) {
    return emit_request_error(request, timConversionStatus_UNSUPPORTED_TIME_SYSTEM, "Target time system is not supported.");
  }
  if (is_gnss_epoch_representation(source->EPOCH_FORMAT()) &&
      !supports_gnss_seconds_representation(source_scale)) {
    const char* representation = gnss_epoch_representation_name(source->EPOCH_FORMAT());
    char message[96];
    std::snprintf(message, sizeof(message), "%s is not valid for the source time system.", representation);
    return emit_request_error(request, timConversionStatus_INVALID_INPUT,
                              message);
  }
  if (is_gnss_epoch_representation(request->TARGET_EPOCH_FORMAT()) &&
      !supports_gnss_seconds_representation(target_scale)) {
    const char* representation = gnss_epoch_representation_name(request->TARGET_EPOCH_FORMAT());
    char message[96];
    std::snprintf(message, sizeof(message), "%s is not valid for the target time system.", representation);
    return emit_request_error(request, timConversionStatus_INVALID_INPUT,
                              message);
  }
  if (source->EPOCH_FORMAT() == timEpochRepresentation_CCSDS_TIME_CODE) {
    const TIMCcsdsTimeCode* code = source->CCSDS_TIME_CODE();
    if (code == nullptr) {
      return emit_request_error(request, timConversionStatus_INVALID_INPUT,
                                "CCSDS_TIME_CODE source requires CCSDS_TIME_CODE payload.");
    }
    if (code->CODE_KIND() == timCcsdsTimeCodeKind_UNSEGMENTED &&
        source_scale != timingStandard_TAI) {
      return emit_request_error(request, timConversionStatus_INVALID_INPUT,
                                "CCSDS unsegmented CUC source currently requires TAI time system.");
    }
    if (code->CODE_KIND() == timCcsdsTimeCodeKind_DAY_SEGMENTED &&
        source_scale != timingStandard_UTC) {
      return emit_request_error(request, timConversionStatus_INVALID_INPUT,
                                "CCSDS day-segmented CDS source currently requires UTC time system.");
    }
    if (code->CODE_KIND() == timCcsdsTimeCodeKind_CALENDAR_SEGMENTED &&
        source_scale != timingStandard_UTC) {
      return emit_request_error(request, timConversionStatus_INVALID_INPUT,
                                "CCSDS calendar-segmented CCS source currently requires UTC time system.");
    }
  }
  if (request->TARGET_EPOCH_FORMAT() == timEpochRepresentation_CCSDS_TIME_CODE) {
    if (target_scale != timingStandard_TAI && target_scale != timingStandard_UTC) {
      return emit_request_error(request, timConversionStatus_INVALID_INPUT,
                                "CCSDS_TIME_CODE target formatting currently supports TAI CUC and UTC CDS only.");
    }
  }

  double local_seconds = 0.0;
  bool source_utc_leap_second = false;
  bool has_source_offset_override = false;
  double source_offset_override = 0.0;
  if (!source_local_seconds(
          source,
          request,
          &local_seconds,
          &source_utc_leap_second,
          &has_source_offset_override,
          &source_offset_override)) {
    return emit_request_error(request, timConversionStatus_INVALID_INPUT, "Source TIMInstant epoch is invalid.");
  }

  const double source_offset =
      offset_from_tai_for_local(source_scale,
                                local_seconds,
                                request,
                                source_utc_leap_second,
                                has_source_offset_override,
                                source_offset_override);
  const double tai_seconds = local_seconds - source_offset;
  bool target_utc_leap_second = false;
  const double target_local_seconds = target_local_from_tai(target_scale, tai_seconds, request, &target_utc_leap_second);
  const double target_offset = offset_from_tai_for_target(target_scale, tai_seconds, request);
  const double delta_seconds = target_offset - source_offset;
  if (request->TARGET_EPOCH_FORMAT() == timEpochRepresentation_CCSDS_TIME_CODE) {
    std::vector<uint8_t> target_ccsds_time_field;
    timCcsdsTimeCodeKind target_kind = timCcsdsTimeCodeKind_NONE;
    uint8_t preamble1 = 0;
    uint8_t preamble2 = 0;
    const char* agency_epoch = nullptr;
    const bool target_in_range =
        target_scale == timingStandard_TAI
            ? target_tai_ccsds_time_field(
                  source,
                  target_local_seconds,
                  &target_kind,
                  &preamble1,
                  &preamble2,
                  &agency_epoch,
                  nullptr,
                  &target_ccsds_time_field)
            : target_utc_ccsds_time_field(
                  source,
                  target_local_seconds,
                  &target_kind,
                  &preamble1,
                  &agency_epoch,
                  &target_ccsds_time_field);
    if (!target_in_range) {
      return emit_request_error(request, timConversionStatus_OUT_OF_RANGE,
                                "CCSDS_TIME_CODE target instant is outside the supported target range.");
    }
  }

  return emit_result(
      source,
      target_scale,
      request->TARGET_EPOCH_FORMAT(),
      target_local_seconds,
      delta_seconds,
      target_utc_leap_second,
      timConversionStatus_OK,
      nullptr,
      trace);
}
