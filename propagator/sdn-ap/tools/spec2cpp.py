#!/usr/bin/env python3
# Mechanical transcription of SPEC.md formula blocks (side A's notation) into C++ expressions.
# Usage: python3 tools/spec2cpp.py SPEC.md src/xp_spec_terms.inc [--hoist-linear] (SPEC.md: side A's, read from main)
import re, sys

spec = open(sys.argv[1]).read().split('\n')

def block(start_pat, stop_pats):
    """Lines after the heading line matching start_pat until a line matching any stop pattern."""
    out, on = [], False
    for line in spec:
        if not on and re.match(start_pat, line):
            on = True
            continue
        if on:
            if any(re.match(p, line) for p in stop_pats):
                break
            out.append(line)
    return out

def items(lines):
    """Join '- ' items with their continuation lines."""
    res = []
    for line in lines:
        if line.startswith('- '):
            res.append(line[2:].strip())
        elif line.startswith('  ') and res:
            res[-1] += ' ' + line.strip()
    return res

NAMES = {'omega': 'w', 'i': 'inc', 'C': 'Cw', 'E': 'E', 'eta': 'eta', 'e': 'e', 'n': 'n', 's': 's', 'c': 'c',
         'p': 'p', 'A': 'A', 'B': 'B', 'Omega': 'O', 'a': 'a'}
FUNCS = {'sin': 'std::sin', 'cos': 'std::cos'}

def tokenize(text):
    toks, k = [], 0
    while k < len(text):
        ch = text[k]
        if ch.isspace():
            k += 1
            continue
        m = re.match(r'\d+(\.\d+)?', text[k:])
        if m:
            toks.append(('num', m.group(0)))
            k += len(m.group(0))
            continue
        m = re.match(r'[A-Za-z_][A-Za-z_0-9]*', text[k:])
        if m:
            toks.append(('id', m.group(0)))
            k += len(m.group(0))
            continue
        if ch in '+-*/^(),':
            toks.append(('op', ch))
            k += 1
            continue
        raise ValueError(f'bad char {ch!r} in {text!r}')
    return toks

class Parser:
    # expr := term (('+'|'-') term)* ; term := unary (('*'|'/'|implicit) unary)* ; unary := '-' unary | power
    # power := atom ('^' num)? ; atom := num | id | func '(' expr ')' | '(' expr ')'
    def __init__(self, toks):
        self.t, self.k = toks, 0
    def peek(self):
        return self.t[self.k] if self.k < len(self.t) else ('end', '')
    def take(self, kind=None, val=None):
        tok = self.peek()
        if (kind and tok[0] != kind) or (val and tok[1] != val):
            raise ValueError(f'expected {kind} {val} got {tok} at {self.k}')
        self.k += 1
        return tok
    def expr(self):
        s = self.term()
        while self.peek() in (('op', '+'), ('op', '-')):
            op = self.take()[1]
            s = f'{s} {op} {self.term()}'
        return s
    def starts_atom(self):
        tok = self.peek()
        return tok[0] in ('num', 'id') or tok == ('op', '(')
    def term(self):
        s = self.unary()
        while True:
            tok = self.peek()
            if tok in (('op', '*'), ('op', '/')):
                op = self.take()[1]
                s = f'{s} {op} {self.unary()}'
            elif self.starts_atom():
                s = f'{s} * {self.unary()}'
            else:
                return s
    def unary(self):
        if self.peek() == ('op', '-'):
            self.take()
            return f'(-{self.unary()})'
        return self.power()
    def power(self):
        a = self.atom()
        if self.peek() == ('op', '^'):
            self.take()
            k = int(self.take('num')[1])
            return f'ipow<{k}>({a})'
        return a
    def atom(self):
        tok = self.peek()
        if tok[0] == 'num':
            self.take()
            return tok[1] + ('.0' if '.' not in tok[1] else '')
        if tok[0] == 'id':
            self.take()
            if tok[1] in FUNCS:
                self.take('op', '(')
                inner = self.expr()
                self.take('op', ')')
                return f'{FUNCS[tok[1]]}({inner})'
            if tok[1] not in NAMES:
                raise ValueError(f'unknown name {tok[1]}')
            return NAMES[tok[1]]
        if tok == ('op', '('):
            self.take()
            inner = self.expr()
            self.take('op', ')')
            return f'({inner})'
        raise ValueError(f'bad atom {tok}')

def cpp(text):
    p = Parser(tokenize(text))
    out = p.expr()
    if p.k != len(p.t):
        raise ValueError(f'trailing tokens in {text!r}: {p.t[p.k:]}')
    return out

def split_brackets(text):
    """'mono [x] + mono [y] + [z]' -> [(mono, x), ...]."""
    res, k, depth, mono, start = [], 0, 0, '', None
    cur_mono = ''
    while k < len(text):
        ch = text[k]
        if ch == '[' and depth == 0:
            depth = 1
            start = k + 1
            mono = cur_mono.strip()
            if mono.startswith('+'):
                mono = mono[1:].strip()
            cur_mono = ''
        elif ch == '[':
            depth += 1
        elif ch == ']':
            depth -= 1
            if depth == 0:
                res.append((mono, text[start:k].strip()))
        elif depth == 0:
            cur_mono += ch
        k += 1
    return res

def mono_cpp(mono):
    if not mono:
        return '1.0'
    return cpp(mono)

out = []
out.append("""// -----------------------------------------------------------------------------
// GENERATED by tools/spec2cpp.py from SPEC.md (side A) formula blocks; never edit
// by hand. Closed forms transcribed mechanically from the notation of SPEC 2
// (explicit zonal rates), SPEC 5 (averaged third-body rates, quadrupole and
// octupole), SPEC 5.4 (output-time third-body corrections) and SPEC 4 (output-
// time SRP corrections, srp_output; averaged SRP rates, srp_rates_sunlit and
// srp_rates_arc). The six-component functions fill n-dot, e-dot, i-dot,
// e varpi-dot, sin i Omega-dot, lambda-dot - n (rad/min; for 5.4 the
// corrections Delta n, Delta e, Delta i, e Delta varpi, sin i Delta Omega,
// Delta lambda); the SPEC 4 functions fill the state order a_f, a_g, chi, psi,
// lambda, n. Each function evaluates sin and cos of E, omega and i once and
// builds the multiples and 2E -/+ omega by angle addition. The 5 and 5.4
// brackets depend on the satellite only: *_coefs fills them once, and each body
// applies them.
// -----------------------------------------------------------------------------""")

# --- section 2: zonal rates
names2 = [('e-dot', 'edot'), ('i-dot', 'idot'), ('e varpi-dot', 'evdot'), ('sin i Omega-dot', 'sodot'),
          ('lambda-dot - n', 'ldot')]
out.append('inline void zonal_six(double e, double n, double s, double c, double eta, double p, double w, double inc, double* six) {')
for title, var in names2:
    lines = block(r'^\*\*' + re.escape(title) + r'\*\* =\s*$', [r'^\*\*', r'^These are', r'^## '])
    terms = []
    for it in items(lines):
        m = re.match(r'(J2\^2|J2|J3|J4|J5) x \[(.*)\]$', it)
        if not m:
            raise ValueError(f'unparsed zonal item: {it}')
        coef = {'J2^2': '(kJ2 * kJ2)', 'J2': 'kJ2', 'J3': 'kJ3', 'J4': 'kJ4', 'J5': 'kJ5'}[m.group(1)]
        terms.append(f'{coef} * ({cpp(m.group(2))})')
    out.append(f'  const double {var} =\n      ' + '\n      + '.join(terms) + ';')
out.append('  six[0] = 0.0;\n  six[1] = edot;\n  six[2] = idot;\n  six[3] = evdot;\n  six[4] = sodot;\n  six[5] = ldot;\n}\n')

# --- section 5: averaged third-body rates (Q2, Q3 per component)
sec5 = block(r'^\*\*In the rates, averaged regime', [r'^\*\*At the output time'])
names5 = [('e-dot', 1), ('i-dot', 2), ('e varpi-dot', 3), ('sin i Omega-dot', 4), ('lambda-dot - n', 5)]

def q_blocks(lines, title):
    on, collected = False, []
    for line in lines:
        if re.match(r'^\*\*' + re.escape(title) + r'\*\* = C2', line):
            on = True
            continue
        if on and line.startswith('**'):
            break
        if on:
            collected.append(line)
    qs = {}
    for it in items(collected):
        m = re.match(r'(Q2|Q3) = (.*)$', it)
        if m:
            qs[m.group(1)] = m.group(2)
    return qs

def q_cpp(text):
    parts = []
    for mono, br in split_brackets(text):
        parts.append(f'({mono_cpp(mono)}) * ({cpp(br)})')
    return '\n        + '.join(parts)

def emit_split(name, args, sec_lines, names):
    """<name>_coefs(args, coef) fills the brackets (they depend on the satellite only); <name>(coef, A, B, Cw, C2, C3,
    six) adds one body's C2 Q2 + C3 Q3 to the six components."""
    terms = []  # (idx, order 'Q2'/'Q3', [(mono_cpp, k)])
    coefs = []
    for title, idx in names:
        qs = q_blocks(sec_lines, title)
        for order in ('Q2', 'Q3'):
            mons = []
            for mono, br in split_brackets(qs[order]):
                coefs.append(cpp(br))
                mons.append((mono_cpp(mono), len(coefs) - 1))
            terms.append((idx, order, mons))
    out.append(f'constexpr int k{name.capitalize()}Coefs = {len(coefs)};')
    out.append(f'inline void {name}_coefs({args}, double* coef) {{')
    for k, c in enumerate(coefs):
        out.append(f'  coef[{k}] = {c};')
    out.append('}\n')
    out.append(f'inline void {name}(const double* coef, double A, double B, double Cw, double C2, double C3, double* six) {{')
    by_idx = {}
    for idx, order, mons in terms:
        by_idx.setdefault(idx, {})[order] = mons
    for idx in sorted(by_idx):
        q2 = '\n        + '.join(f'({m}) * coef[{k}]' for m, k in by_idx[idx]['Q2'])
        q3 = '\n        + '.join(f'({m}) * coef[{k}]' for m, k in by_idx[idx]['Q3'])
        out.append(f'  six[{idx}] += C2 * (\n        {q2})\n    + C3 * (\n        {q3});')
    out.append('}\n')

emit_split('third_body_six', 'double e, double n, double eta, double inc, double w', sec5, names5)
sec54 = block(r'^### 5\.4 Output-time third-body corrections, explicit', [r'^\*\*Long-period regime'])
names54 = [('Delta n', 0), ('Delta e', 1), ('Delta i', 2), ('e Delta varpi', 3), ('sin i Delta Omega', 4), ('Delta lambda', 5)]
emit_split('output_six', 'double e, double n, double eta, double inc, double w, double E', sec54, names54)

# --- section 4: output-time SRP terms (the Sun's A, B, C; Fs the SRP acceleration)
sec4 = block(r'^\*\*Output-time SRP periodic terms\.\*\*', [r'^\*\[probe 4\.3\]\*'])
srp_names = [('Delta lambda', 4), ('Delta n', 5), ('Delta chi', 2), ('Delta psi', 3), ('Delta a_f', 0), ('Delta a_g', 1)]
out.append('// Output-time SRP corrections to the equinoctial elements (SPEC 4), in the order of the state: d[0] a_f,')
out.append('// d[1] a_g, d[2] chi, d[3] psi, d[4] lambda, d[5] n.')
out.append('inline void srp_output(double e, double eta, double E, double w, double O, double inc, double a, double n,')
out.append('                       double A, double B, double Cw, double Fs, double* d) {')
for title, idx in srp_names:
    it = next(x for x in items(sec4) if x.startswith(title + ' = F_s'))
    inner = it[len(title + ' = F_s'):].strip()
    assert inner.startswith('(') and inner.endswith(')'), title
    parts = []
    for mono, br in split_brackets(inner[1:-1]):
        parts.append(f'({mono_cpp(mono)}) * ({cpp(br)})')
    out.append(f'  d[{idx}] = Fs * (\n        ' + '\n        + '.join(parts) + ');')
out.append('}\n')

# --- section 4: averaged SRP rates (wholly sunlit; sunlit arc from E_1 to E_2), in the order of the state
NAMES.update({'E_1': 'E1', 'E_2': 'E2', 'pi': 'kPi'})
srp_rate_names = [('lambda-dot', 4), ('n-dot', 5), ('chi-dot', 2), ('psi-dot', 3), ('a_f-dot', 0), ('a_g-dot', 1)]

def srp_rate_fn(name, args, title):
    sec = block(r'^\*\*' + re.escape(title) + r'\*\*\s*$', [r'^\*\*', r'^\*\[probe'])
    out.append(f'// SPEC 4 averaged SRP rates, {title[:-1].lower()}: d[0] a_f, d[1] a_g, d[2] chi, d[3] psi, d[4] lambda, d[5] n.')
    out.append(f'inline void {name}({args}, double* d) {{')
    for title_, idx in srp_rate_names:
        it = next(x for x in items(sec) if x.startswith(title_ + ' = '))
        rhs = it[len(title_ + ' = '):].strip()
        if rhs == '0':
            out.append(f'  d[{idx}] = 0.0;')
            continue
        assert rhs.startswith('F_s (') and rhs.endswith(')'), title_
        parts = [f'({mono_cpp(mono)}) * ({cpp(br)})' for mono, br in split_brackets(rhs[len('F_s ('):-1])]
        out.append(f'  d[{idx}] = Fs * (\n        ' + '\n        + '.join(parts) + ');')
    out.append('}\n')

srp_rate_fn('srp_rates_sunlit', 'double e, double eta, double w, double O, double inc, double a, double n, double A, double B, double Cw, double Fs',
            'Wholly sunlit orbit:')
srp_rate_fn('srp_rates_arc', 'double e, double eta, double w, double O, double inc, double a, double n, double E1, double E2, double A, double B, double Cw, double Fs',
            'Sunlit arc from E_1 to E_2:')

# Common trigonometric calls: each distinct call is evaluated once per function (the same call, the same value).
def hoist_trig(src):
    """Each distinct sin/cos call once per function; multiples k X (k <= 4) of E, w, inc and the angles
    2E -/+ w are built from cos X, sin X by angle addition."""
    lines = src.split('\n')
    head, funcs, cur = [], [], None
    for line in lines:
        if line.startswith('inline void '):
            if cur is not None: funcs.append(cur)
            cur = [line]
        elif cur is None:
            head.append(line)
        else:
            cur.append(line)
    if cur is not None: funcs.append(cur)
    res = head[:]
    for f in funcs:
        text = '\n'.join(f)
        sig_end = text.index('{') + 1
        body = text[sig_end:]
        calls = []
        for m in re.finditer(r'std::(sin|cos)\(([^()]*)\)', body):
            if m.group(0) not in calls: calls.append(m.group(0))
        need = {}  # base -> max multiple
        expr = {}
        for call in calls:
            fn, arg = re.match(r'std::(sin|cos)\(([^()]*)\)', call).groups()
            m1 = re.match(r'^(?:(\d)\.0 \* )?(E|w|inc)$', arg)
            m2 = re.match(r'^2\.0 \* E ([-+]) w$', arg)
            if m1:
                k = int(m1.group(1) or 1)
                base = m1.group(2)
                need[base] = max(need.get(base, 1), k)
                expr[call] = f'{"c" if fn == "cos" else "s"}{base}{k}'
            elif m2:
                need['E'] = max(need.get('E', 1), 2)
                need['w'] = max(need.get('w', 1), 1)
                if fn == 'cos':
                    expr[call] = '(cE2 * cw1 + sE2 * sw1)' if m2.group(1) == '-' else '(cE2 * cw1 - sE2 * sw1)'
                else:
                    expr[call] = '(sE2 * cw1 - cE2 * sw1)' if m2.group(1) == '-' else '(sE2 * cw1 + cE2 * sw1)'
            else:
                expr[call] = call
        decls = ''
        for base, kmax in need.items():
            decls += f'\n  double c{base}1, s{base}1;\n  fm::sincos({base}, s{base}1, c{base}1);'
            for k in range(2, kmax + 1):
                decls += (f'\n  const double c{base}{k} = c{base}{k-1} * c{base}1 - s{base}{k-1} * s{base}1, '
                          f's{base}{k} = s{base}{k-1} * c{base}1 + c{base}{k-1} * s{base}1;')
        body = re.sub(r'std::(sin|cos)\(([^()]*)\)', lambda m: expr[m.group(0)], body)
        res.append(text[:sig_end] + decls + body)
    return '\n'.join(res)


# The SPEC 4 averaged SRP rate functions: every sin/cos argument is a linear combination of E1, E2, O and w with
# integer coefficients; each is built from the four base sine/cosine pairs by angle addition (four sincos calls in
# place of some thirty distinct sines and cosines).
def hoist_linear(src, names=("srp_rates_arc", "srp_rates_sunlit")):
    def parse_lin(arg):
        terms = {}
        a = arg.replace(" ", "")
        for m in re.finditer(r"([+-]?)(?:\(([-]?)(\d+\.0)\)\*|(\d+\.0)\*|\((-)?)?(E1|E2|O|w)\)?", a):
            pass
        # tokens: optional sign, optional coefficient, symbol
        tokens = re.findall(r"([+-]?)(\(?-?\d+\.0\)?\*)?\(?(-?)(E1|E2|O|w)\)?", a)
        rebuilt = ""
        for sign, coef, inner_neg, sym in tokens:
            k = 1
            if coef:
                k = int(float(coef.strip("()*")))
            if inner_neg == "-":
                k = -k
            if sign == "-":
                k = -k
            terms[sym] = terms.get(sym, 0) + k
        return terms
    lines = src.split("\n")
    res, i = [], 0
    while i < len(lines):
        line = lines[i]
        m = re.match(r"inline void (\w+)\(", line)
        if m and m.group(1) in names:
            j = i
            while not lines[j].rstrip().endswith("{"):
                j += 1
            k = j + 1
            depth = 1
            body = []
            while depth > 0:
                depth += lines[k].count("{") - lines[k].count("}")
                body.append(lines[k])
                k += 1
            text = "\n".join(body)
            calls = []
            for mm in re.finditer(r"std::(sin|cos)\(((?:[^()]|\([^()]*\))*)\)", text):
                if mm.group(2) not in calls:
                    calls.append(mm.group(2))
            combos, bases = {}, set()
            for arg in calls:
                t = parse_lin(arg)
                if not t:
                    raise ValueError("unparsed trig argument " + arg)
                combos[arg] = t
                for sym, kk in t.items():
                    bases.add((sym, abs(kk)))
            decl = []
            maxk = {}
            for sym, kk in bases:
                maxk[sym] = max(maxk.get(sym, 1), kk)
            for sym in sorted(maxk):
                decl.append(f"  double c_{sym}1, s_{sym}1;\n  fm::sincos({sym}, s_{sym}1, c_{sym}1);")
                for kk in range(2, maxk[sym] + 1):
                    decl.append(f"  const double c_{sym}{kk} = c_{sym}{kk-1} * c_{sym}1 - s_{sym}{kk-1} * s_{sym}1, "
                                f"s_{sym}{kk} = s_{sym}{kk-1} * c_{sym}1 + c_{sym}{kk-1} * s_{sym}1;")
            names_cs = {}
            for idx, (arg, t) in enumerate(combos.items()):
                items = [(sym, kk) for sym, kk in sorted(t.items()) if kk != 0]
                sym, kk = items[0]
                c = f"c_{sym}{abs(kk)}"
                sn = f"s_{sym}{abs(kk)}" if kk > 0 else f"(-s_{sym}{abs(kk)})"
                for sym2, kk2 in items[1:]:
                    c2 = f"c_{sym2}{abs(kk2)}"
                    s2 = f"s_{sym2}{abs(kk2)}" if kk2 > 0 else f"(-s_{sym2}{abs(kk2)})"
                    c, sn = f"({c} * {c2} - {sn} * {s2})", f"({sn} * {c2} + {c} * {s2})"
                decl.append(f"  const double cl{idx} = {c}, sl{idx} = {sn};  // {arg}")
                names_cs[arg] = idx
            def repl(mm):
                return ("cl" if mm.group(1) == "cos" else "sl") + str(names_cs[mm.group(2)])
            text = re.sub(r"std::(sin|cos)\(((?:[^()]|\([^()]*\))*)\)", repl, text)
            res.extend(lines[i:j + 1])
            res.extend(decl)
            res.extend(text.split("\n"))
            i = k
            continue
        res.append(line)
        i += 1
    return "\n".join(res)

text = hoist_trig('\n'.join(out))
if '--hoist-linear' in sys.argv:  # bit-changing speed-up of the SRP rate trig; off (see README: CPU)
    text = hoist_linear(text)
open(sys.argv[2], 'w').write(text + '\n')
print('ok', sys.argv[2])
