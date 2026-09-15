#include "conjunction/error_status.h"
/*
 * Copyright 2013 Daniel Warner <contact@danrw.com>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */


#include "Tle.h"

#include <cctype>
#include <cmath>
#include <locale>

namespace libsgp4
{
namespace
{
    static const unsigned int TLE1_COL_NORADNUM = 2;
    static const unsigned int TLE1_LEN_NORADNUM = 5;
    static const unsigned int TLE1_COL_INTLDESC_A = 9;
    static const unsigned int TLE1_LEN_INTLDESC_A = 2;
//  static const unsigned int TLE1_COL_INTLDESC_B = 11;
    static const unsigned int TLE1_LEN_INTLDESC_B = 3;
//  static const unsigned int TLE1_COL_INTLDESC_C = 14;
    static const unsigned int TLE1_LEN_INTLDESC_C = 3;
    static const unsigned int TLE1_COL_EPOCH_A = 18;
    static const unsigned int TLE1_LEN_EPOCH_A = 2;
    static const unsigned int TLE1_COL_EPOCH_B = 20;
    static const unsigned int TLE1_LEN_EPOCH_B = 12;
    static const unsigned int TLE1_COL_MEANMOTIONDT2 = 33;
    static const unsigned int TLE1_LEN_MEANMOTIONDT2 = 10;
    static const unsigned int TLE1_COL_MEANMOTIONDDT6 = 44;
    static const unsigned int TLE1_LEN_MEANMOTIONDDT6 = 8;
    static const unsigned int TLE1_COL_BSTAR = 53;
    static const unsigned int TLE1_LEN_BSTAR = 8;
//  static const unsigned int TLE1_COL_EPHEMTYPE = 62;
//  static const unsigned int TLE1_LEN_EPHEMTYPE = 1;
//  static const unsigned int TLE1_COL_ELNUM = 64;
//  static const unsigned int TLE1_LEN_ELNUM = 4;

    static const unsigned int TLE2_COL_NORADNUM = 2;
    static const unsigned int TLE2_LEN_NORADNUM = 5;
    static const unsigned int TLE2_COL_INCLINATION = 8;
    static const unsigned int TLE2_LEN_INCLINATION = 8;
    static const unsigned int TLE2_COL_RAASCENDNODE = 17;
    static const unsigned int TLE2_LEN_RAASCENDNODE = 8;
    static const unsigned int TLE2_COL_ECCENTRICITY = 26;
    static const unsigned int TLE2_LEN_ECCENTRICITY = 7;
    static const unsigned int TLE2_COL_ARGPERIGEE = 34;
    static const unsigned int TLE2_LEN_ARGPERIGEE = 8;
    static const unsigned int TLE2_COL_MEANANOMALY = 43;
    static const unsigned int TLE2_LEN_MEANANOMALY = 8;
    static const unsigned int TLE2_COL_MEANMOTION = 52;
    static const unsigned int TLE2_LEN_MEANMOTION = 11;
    static const unsigned int TLE2_COL_REVATEPOCH = 63;
    static const unsigned int TLE2_LEN_REVATEPOCH = 5;

    bool TryExtractAlpha5Integer(const std::string& str, unsigned int& val)
    {
        if (str.length() != 5)
        {
            return false;
        }

        const unsigned char first = static_cast<unsigned char>(str[0]);
        if (!isalpha(first))
        {
            return false;
        }

        const char alpha = static_cast<char>(toupper(first));
        unsigned int prefix = 0;
        if (alpha >= 'A' && alpha <= 'H')
        {
            prefix = 10 + static_cast<unsigned int>(alpha - 'A');
        }
        else if (alpha >= 'J' && alpha <= 'N')
        {
            prefix = 18 + static_cast<unsigned int>(alpha - 'J');
        }
        else if (alpha >= 'P' && alpha <= 'Z')
        {
            prefix = 23 + static_cast<unsigned int>(alpha - 'P');
        }
        else
        {
            conjunction::set_error("Invalid Alpha-5 character"); return false;
        }

        unsigned int suffix = 0;
        for (size_t index = 1; index < str.length(); ++index)
        {
            const unsigned char ch = static_cast<unsigned char>(str[index]);
            if (!isdigit(ch))
            {
                conjunction::set_error("Invalid Alpha-5 digit"); return false;
            }
            suffix = (suffix * 10U) + static_cast<unsigned int>(ch - '0');
        }

        val = prefix * 10000U + suffix;
        return true;
    }
}

/**
 * Initialise the tle object.
 * @exception TleException
 */
void Tle::Initialize()
{
    if (conjunction::has_error()) return;
    if (!IsValidLineLength(line_one_))
    {
        conjunction::set_error("Invalid length for line one"); return;
    }

    if (!IsValidLineLength(line_two_))
    {
        conjunction::set_error("Invalid length for line two"); return;
    }

    if (line_one_[0] != '1')
    {
        conjunction::set_error("Invalid line beginning for line one"); return;
    }
        
    if (line_two_[0] != '2')
    {
        conjunction::set_error("Invalid line beginning for line two"); return;
    }

    unsigned int sat_number_1 = 0;
    unsigned int sat_number_2 = 0;

    ExtractInteger(line_one_.substr(TLE1_COL_NORADNUM,
                TLE1_LEN_NORADNUM), sat_number_1);
    if (conjunction::has_error()) return;
    ExtractInteger(line_two_.substr(TLE2_COL_NORADNUM,
                TLE2_LEN_NORADNUM), sat_number_2);
    if (conjunction::has_error()) return;

    if (sat_number_1 != sat_number_2)
    {
        conjunction::set_error("Satellite numbers do not match"); return;
    }

    norad_number_ = sat_number_1;

    if (name_.empty())
    {
        name_ = line_one_.substr(TLE1_COL_NORADNUM, TLE1_LEN_NORADNUM);
    }

    int_designator_ = line_one_.substr(TLE1_COL_INTLDESC_A,
            TLE1_LEN_INTLDESC_A + TLE1_LEN_INTLDESC_B + TLE1_LEN_INTLDESC_C);

    unsigned int year = 0;
    double day = 0.0;

    ExtractInteger(line_one_.substr(TLE1_COL_EPOCH_A,
                TLE1_LEN_EPOCH_A), year);
    if (conjunction::has_error()) return;
    ExtractDouble(line_one_.substr(TLE1_COL_EPOCH_B,
                TLE1_LEN_EPOCH_B), 4, day);
    if (conjunction::has_error()) return;
    ExtractDouble(line_one_.substr(TLE1_COL_MEANMOTIONDT2,
                TLE1_LEN_MEANMOTIONDT2), 2, mean_motion_dt2_);
    if (conjunction::has_error()) return;
    ExtractExponential(line_one_.substr(TLE1_COL_MEANMOTIONDDT6,
                TLE1_LEN_MEANMOTIONDDT6), mean_motion_ddt6_);
    if (conjunction::has_error()) return;
    ExtractExponential(line_one_.substr(TLE1_COL_BSTAR,
                TLE1_LEN_BSTAR), bstar_);
    if (conjunction::has_error()) return;

    /*
     * line 2
     */
    ExtractDouble(line_two_.substr(TLE2_COL_INCLINATION,
                TLE2_LEN_INCLINATION), 4, inclination_);
    if (conjunction::has_error()) return;
    ExtractDouble(line_two_.substr(TLE2_COL_RAASCENDNODE,
                TLE2_LEN_RAASCENDNODE), 4, right_ascending_node_);
    if (conjunction::has_error()) return;
    ExtractDouble(line_two_.substr(TLE2_COL_ECCENTRICITY,
                TLE2_LEN_ECCENTRICITY), -1, eccentricity_);
    if (conjunction::has_error()) return;
    ExtractDouble(line_two_.substr(TLE2_COL_ARGPERIGEE,
                TLE2_LEN_ARGPERIGEE), 4, argument_perigee_);
    if (conjunction::has_error()) return;
    ExtractDouble(line_two_.substr(TLE2_COL_MEANANOMALY,
                TLE2_LEN_MEANANOMALY), 4, mean_anomaly_);
    if (conjunction::has_error()) return;
    ExtractDouble(line_two_.substr(TLE2_COL_MEANMOTION,
                TLE2_LEN_MEANMOTION), 3, mean_motion_);
    if (conjunction::has_error()) return;
    ExtractInteger(line_two_.substr(TLE2_COL_REVATEPOCH,
                TLE2_LEN_REVATEPOCH), orbit_number_);
    if (conjunction::has_error()) return;
    
    if (year < 57)
    {
        year += 2000;
    }
    else
    {
        year += 1900;
    }

    // Native TLE day zero names the preceding December 31 (Kelso's TLE
    // format FAQ, https://celestrak.org/columns/v04n03/). Reject other
    // out-of-calendar days before constructing the propagation epoch.
    const bool leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    if (!std::isfinite(day) || day < 0.0 || day >= (leap ? 367.0 : 366.0))
    {
        conjunction::set_error("Invalid TLE epoch day"); return;
    }
    if (!std::isfinite(inclination_) || inclination_ < 0.0 || inclination_ > 180.0 ||
        !std::isfinite(right_ascending_node_) || right_ascending_node_ < 0.0 || right_ascending_node_ >= 360.0 ||
        !std::isfinite(argument_perigee_) || argument_perigee_ < 0.0 || argument_perigee_ >= 360.0 ||
        !std::isfinite(mean_anomaly_) || mean_anomaly_ < 0.0 || mean_anomaly_ >= 360.0 ||
        !std::isfinite(eccentricity_) || eccentricity_ < 0.0 || eccentricity_ >= 1.0 ||
        !std::isfinite(mean_motion_) || mean_motion_ <= 0.0)
    {
        conjunction::set_error("TLE orbital elements are outside SGP4 bounds"); return;
    }

    epoch_ = DateTime(year, day);
}

/**
 * Check 
 * @param str The string to check
 * @returns Whether true of the string has a valid length
 */
bool Tle::IsValidLineLength(const std::string& str)
{
    return str.length() == LineLength() ? true : false;
}

/**
 * Convert a string containing an integer
 * @param[in] str The string to convert
 * @param[out] val The result
 * @exception TleException on conversion error
 */
void Tle::ExtractInteger(const std::string& str, unsigned int& val)
{
    val = 0;
    if (conjunction::has_error()) return;
    if (TryExtractAlpha5Integer(str, val))
    {
        return;
    }

    if (conjunction::has_error()) return;
    bool found_digit = false;
    unsigned int temp = 0;

    for (auto& i : str)
    {
        if (isdigit(i))
        {
            found_digit = true;
            temp = (temp * 10) + static_cast<unsigned int>(i - '0');
        }
        else if (found_digit)
        {
            conjunction::set_error("Unexpected non digit"); return;
        }
        else if (i != ' ')
        {
            conjunction::set_error("Invalid character"); return;
        }
    }

    if (!found_digit)
    {
        val = 0;
    }
    else
    {
        val = temp;
    }
}

/**
 * Convert a string containing an double
 * @param[in] str The string to convert
 * @param[in] point_pos The position of the decimal point. (-1 if none)
 * @param[out] val The result
 * @exception TleException on conversion error
 */
void Tle::ExtractDouble(const std::string& str, int point_pos, double& val)
{
    val = 0.0;
    if (conjunction::has_error()) return;
    std::string temp;
    bool found_digit = false;

    for (std::string::const_iterator i = str.begin(); i != str.end(); ++i)
    {
        /*
         * integer part
         */
        if (point_pos >= 0 && i < str.begin() + point_pos - 1)
        {
            bool done = false;

            if (i == str.begin())
            {
                if(*i == '-' || *i == '+')
                {
                    /*
                     * first character could be signed
                     */
                    temp += *i;
                    done = true;
                }
            }

            if (!done)
            {
                if (isdigit(*i))
                {
                    found_digit = true;
                    temp += *i;
                }
                else if (found_digit)
                {
                    conjunction::set_error("Unexpected non digit"); return;
                }
                else if (*i != ' ')
                {
                    conjunction::set_error("Invalid character"); return;
                }
            }
        }
        /*
         * decimal point
         */
        else if (point_pos >= 0 && i == str.begin() + point_pos - 1)
        {
            if (temp.length() == 0)
            {
                /*
                 * integer part is blank, so add a '0'
                 */
                temp += '0';
            }

            if (*i == '.')
            {
                /*
                 * decimal point found
                 */
                temp += *i;
            }
            else
            {
                conjunction::set_error("Failed to find decimal point"); return;
            }
        }
        /*
         * fraction part
         */
        else
        {
            if (i == str.begin() && point_pos == -1)
            {
                /*
                 * no decimal point expected, add 0. beginning
                 */
                temp += '0';
                temp += '.';
            }
            
            /*
             * should be a digit
             */
            if (isdigit(*i))
            {
                temp += *i;
            }
            else
            {
                conjunction::set_error("Invalid digit"); return;
            }
        }
    }

    if (!Util::FromString<double>(temp, val))
    {
        conjunction::set_error("Failed to convert value to double"); return;
    }
}

/**
 * Convert a string containing an exponential
 * @param[in] str The string to convert
 * @param[out] val The result
 * @exception TleException on conversion error
 */
void Tle::ExtractExponential(const std::string& str, double& val)
{
    val = 0.0;
    if (conjunction::has_error()) return;
    std::string temp;

    for (std::string::const_iterator i = str.begin(); i != str.end(); ++i)
    {
        if (i == str.begin())
        {
            if (*i == '-' || *i == '+' || *i == ' ')
            {
                if (*i == '-')
                {
                    temp += *i;
                }
                temp += '0';
                temp += '.';
            }
            else
            {
                conjunction::set_error("Invalid sign"); return;
            }
        }
        else if (i == str.end() - 2)
        {
            if (*i == '-' || *i == '+')
            {
                temp += 'e';
                temp += *i;
            }
            else
            {
                conjunction::set_error("Invalid exponential sign"); return;
            }
        }
        else
        {
            if (isdigit(*i))
            {
                temp += *i;
            }
            else
            {
                conjunction::set_error("Invalid digit"); return;
            }
        }
    }

    if (!Util::FromString<double>(temp, val))
    {
        conjunction::set_error("Failed to convert value to double"); return;
    }
}

} // namespace libsgp4
