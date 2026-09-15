// Fixture inputs only, using existing ERFA analytics. No Lambert implementation.
// Earth: epv00; Mars: plan94; heliocentric J2000 equatorial, TDB, SI output.
#include "erfa.h"
#include <stdio.h>
static void states(int mars, double jd, int count) {
  printf("{\"epochs\":[");
  for (int i=0;i<count;i++) printf("%s%.17g",i?",":"",(jd+i-2451545.0)*86400);
  printf("],\"positions\":[");
  for (int kind=0;kind<2;kind++) {
    for (int i=0;i<count;i++) {
      double pv[2][3], pvb[2][3];
      int status = mars ? eraPlan94(2451545.0,jd+i-2451545.0,4,pv) : eraEpv00(2451545.0,jd+i-2451545.0,pv,pvb);
      if(status) return;
      const double factor = 149597870700.0/(kind?86400:1);
      printf("%s[%.17g,%.17g,%.17g]",i?",":"",pv[kind][0]*factor,pv[kind][1]*factor,pv[kind][2]*factor);
    }
    printf(kind ? "]}" : "],\"velocities\":[");
  }
}
int main(void) {
  // 2005-07-01..2005-09-01 departure, 2006-02-01..2006-04-30 arrival.
  printf("{\"departure\":"); states(0,2453552.5,63);
  printf(",\"arrival\":"); states(1,2453767.5,89);
  puts("}");
}
