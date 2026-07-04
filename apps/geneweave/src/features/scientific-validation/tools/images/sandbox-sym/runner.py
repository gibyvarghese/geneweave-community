#!/usr/bin/env python3
"""
Symbolic math runner — reads JSON from stdin, dispatches to sympy,
writes JSON result to stdout.

Supported operations:
  simplify  — sympy.simplify(expr)
  solve     — sympy.solve(equations, symbols)
  integrate — sympy.integrate(expr, var)
"""
import sys
import json

def main() -> None:
    try:
        payload = json.loads(sys.stdin.read())
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"Invalid JSON input: {exc}"}))
        sys.exit(1)

    op = payload.get("op")
    try:
        import sympy as sp
        from sympy.parsing.sympy_parser import parse_expr

        if op == "simplify":
            expr = parse_expr(str(payload["expr"]))
            result = sp.simplify(expr)
            print(json.dumps({"ok": True, "result": str(result), "latex": sp.latex(result)}))

        elif op == "solve":
            raw_eqs = payload.get("equations", [])
            raw_syms = payload.get("symbols", [])
            syms = [sp.Symbol(s) for s in raw_syms]
            eqs = [parse_expr(str(eq)) for eq in raw_eqs]
            solution = sp.solve(eqs, syms, dict=True)
            serialised = [{str(k): str(v) for k, v in sol.items()} for sol in solution]
            print(json.dumps({"ok": True, "result": serialised}))

        elif op == "integrate":
            expr = parse_expr(str(payload["expr"]))
            var = sp.Symbol(str(payload["var"]))
            limits = payload.get("limits")
            if limits:
                lower = parse_expr(str(limits[0]))
                upper = parse_expr(str(limits[1]))
                result = sp.integrate(expr, (var, lower, upper))
            else:
                result = sp.integrate(expr, var)
            print(json.dumps({"ok": True, "result": str(result), "latex": sp.latex(result)}))

        else:
            print(json.dumps({"ok": False, "error": f"Unknown operation: {op}"}))
            sys.exit(1)

    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
