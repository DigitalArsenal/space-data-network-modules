! Oracle driver for the C++ port: evaluates every public HWM14 routine of the
! unmodified nrl/hwm14.f90 on oracle inputs and writes the raw float32 results.
! Usage: oracle <inputs.bin> <outputs.bin> <order: 1 forward, -1 reverse>
program oracle
  implicit none
  integer :: ngeo, nmag, nap, k, i, dir, u
  integer, allocatable :: iyd(:)
  real(4), allocatable :: g(:,:), m(:,:), apv(:)
  real(4), allocatable :: og(:,:), om(:,:), oa(:,:)
  real(4) :: ap(2), w(2), qw(2), dw(2), mmp, mzp, qlat, qlon, f1e, f1n, f2e, f2n, mlt, kpt(0:2)
  real(4), external :: ap2kp, mltcalc, latwgt2
  character(512) :: fin, fout, sdir
  call get_command_argument(1, fin); call get_command_argument(2, fout); call get_command_argument(3, sdir)
  read(sdir, *) dir
  open(newunit=u, file=trim(fin), access='stream', form='unformatted', status='old')
  read(u) ngeo
  allocate(iyd(ngeo), g(5, ngeo))
  do k = 1, ngeo
    read(u) iyd(k), g(1:5, k)
  end do
  read(u) nmag
  allocate(m(3, nmag))
  read(u) m
  read(u) nap
  allocate(apv(nap))
  read(u) apv
  close(u)
  allocate(og(15, ngeo), om(2, nmag), oa(5, nap))
  ap(1) = 0.0
  do i = 1, ngeo
    k = i; if (dir < 0) k = ngeo + 1 - i
    ap(2) = g(5, k)
    ! Interleave the routines so any cache leak between them would show.
    call hwm14(iyd(k), g(1,k), g(2,k), g(3,k), g(4,k), 0.0, 0.0, 0.0, ap, w)
    call dwm07(iyd(k), g(1,k), g(2,k), g(3,k), g(4,k), ap, dw)
    ap(2) = -1.0
    call hwm14(iyd(k), g(1,k), g(2,k), g(3,k), g(4,k), 0.0, 0.0, 0.0, ap, qw)
    call gd2qd(g(3,k), g(4,k), qlat, qlon, f1e, f1n, f2e, f2n)
    mlt = mltcalc(qlat, qlon, real(mod(iyd(k),1000)), g(1,k)/3600.0)
    og(1:2,k) = w; og(3:4,k) = qw; og(5:6,k) = dw
    og(7:12,k) = (/ qlat, qlon, f1e, f1n, f2e, f2n /)
    og(13,k) = mlt
    call hwmqt(iyd(k), g(1,k), g(2,k), g(3,k), g(4,k), 0.0, 0.0, 0.0, ap, qw)
    og(14:15,k) = qw
  end do
  do i = 1, nmag
    k = i; if (dir < 0) k = nmag + 1 - i
    call dwm07b(m(1,k), m(2,k), m(3,k), mmp, mzp)
    om(1:2,k) = (/ mmp, mzp /)
  end do
  do i = 1, nap
    k = i; if (dir < 0) k = nap + 1 - i
    oa(1,k) = ap2kp(apv(k))
    call kpspl3(apv(k) / 40.0, kpt)
    oa(2:4,k) = kpt
    oa(5,k) = latwgt2(apv(k) * 0.4 - 84.0, apv(k) / 17.0, apv(k) / 40.0, 4.0)
  end do
  open(newunit=u, file=trim(fout), access='stream', form='unformatted', status='replace')
  write(u) og, om, oa
  close(u)
end program oracle
