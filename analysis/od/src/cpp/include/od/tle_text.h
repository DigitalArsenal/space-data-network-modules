// The legacy two-line element set (TLE) text of a fitted element set: the five-character catalog-number field
// (Alpha-5), the line check digit and the international designator.
//
// Alpha-5 (Space-Track): a catalog number from 100000 to 339999 does not fit five digits, so the field takes a
// letter for the ten-thousands (10..33, A..Z without I and O) and four digits: 100000 is "A0000", 123456 is
// "C3456", 339999 is "Z9999". Numbers below 100000 are five digits, zero padded, as before.
#ifndef OD_TLE_TEXT_H
#define OD_TLE_TEXT_H

#include <cstddef>
#include <string>

namespace od {
namespace tle_text {

constexpr long kMaxCatalogNumber = 339999;

// Writes the five-character field of `number` into out[0..4] (no terminator). False, and out untouched, when the
// number is negative or above 339999.
inline bool encode_catalog_number(long number, char out[5]) {
    if (number < 0 || number > kMaxCatalogNumber) return false;
    static const char letters[] = "ABCDEFGHJKLMNPQRSTUVWXYZ";  // the ten-thousands 10..33
    const long ten_thousands = number / 10000;
    const long rest = number % 10000;
    out[0] = ten_thousands < 10 ? static_cast<char>('0' + ten_thousands) : letters[ten_thousands - 10];
    out[1] = static_cast<char>('0' + rest / 1000);
    out[2] = static_cast<char>('0' + (rest / 100) % 10);
    out[3] = static_cast<char>('0' + (rest / 10) % 10);
    out[4] = static_cast<char>('0' + rest % 10);
    return true;
}

// The check digit of a line: the sum of its digits, each '-' counting one, modulo ten, over its first 68 characters.
inline int checksum(const char* line) {
    int sum = 0;
    for (size_t i = 0; i < 68 && line[i]; ++i) {
        if (line[i] >= '0' && line[i] <= '9') sum += line[i] - '0';
        else if (line[i] == '-') sum += 1;
    }
    return sum % 10;
}

// The eight-character international designator field of an object id: "2024-196Q" is "24196Q  ", "1998-067AB" is
// "98067AB ", and an id already in the two-line form ("99999A", "24196Q") is padded as it is. Eight spaces, the
// field of an unknown designator, when the id is neither.
inline std::string designator_field(const std::string& id) {
    std::string out(8, ' ');
    auto digits = [&](size_t from, size_t to) {
        for (size_t i = from; i < to; ++i) if (id[i] < '0' || id[i] > '9') return false;
        return true;
    };
    auto letters = [&](size_t from) {
        if (id.size() < from + 1 || id.size() > from + 3) return false;
        for (size_t i = from; i < id.size(); ++i) if (id[i] < 'A' || id[i] > 'Z') return false;
        return true;
    };
    if (id.size() >= 9 && id.size() <= 11 && id[4] == '-' && digits(0, 4) && digits(5, 8) && letters(8)) {
        out.replace(0, 2, id, 2, 2);
        out.replace(2, 3, id, 5, 3);
        out.replace(5, id.size() - 8, id, 8, id.size() - 8);
    } else if (id.size() >= 6 && id.size() <= 8 && digits(0, 5) && letters(5)) {
        out.replace(0, id.size(), id);
    }
    return out;
}

}  // namespace tle_text
}  // namespace od

#endif  // OD_TLE_TEXT_H
