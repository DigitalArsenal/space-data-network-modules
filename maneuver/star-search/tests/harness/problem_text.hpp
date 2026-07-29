#ifndef STAR_SEARCH_HARNESS_PROBLEM_TEXT_HPP
#define STAR_SEARCH_HARNESS_PROBLEM_TEXT_HPP

#include "types.hpp"

namespace star_search::harness {

Status parse_problem_file(const char* path, Problem* output);

}  // namespace star_search::harness

#endif
