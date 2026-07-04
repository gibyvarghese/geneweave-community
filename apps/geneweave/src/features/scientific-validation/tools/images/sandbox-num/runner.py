#!/usr/bin/env python3
"""
Numerical / statistical runner — reads JSON from stdin, dispatches to
scipy/statsmodels/pymc/R, writes JSON result to stdout.

Supported operations:
  stats_test        — scipy.stats parametric / non-parametric tests
  meta_analysis     — statsmodels random-effects meta-analysis
  power_analysis    — scipy.stats power analysis (norm.ppf / t_power)
  mcmc_sample       — pymc MCMC posterior sampling
  r_metafor         — R metafor (delegates to Rscript subprocess)
"""
import sys
import json
import subprocess

def main() -> None:
    try:
        payload = json.loads(sys.stdin.read())
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"Invalid JSON input: {exc}"}))
        sys.exit(1)

    op = payload.get("op")
    try:
        if op == "stats_test":
            from scipy import stats
            test_name = payload.get("test", "ttest_ind")
            data_a = payload["data_a"]
            data_b = payload.get("data_b")
            alternative = payload.get("alternative", "two-sided")

            if test_name == "ttest_ind":
                stat, p = stats.ttest_ind(data_a, data_b, alternative=alternative)
            elif test_name == "ttest_1samp":
                popmean = payload.get("popmean", 0)
                stat, p = stats.ttest_1samp(data_a, popmean, alternative=alternative)
            elif test_name == "mannwhitneyu":
                stat, p = stats.mannwhitneyu(data_a, data_b, alternative=alternative)
            elif test_name == "wilcoxon":
                stat, p = stats.wilcoxon(data_a, alternative=alternative)
            elif test_name == "kruskal":
                groups = payload.get("groups", [data_a, data_b])
                stat, p = stats.kruskal(*groups)
            elif test_name == "chi2_contingency":
                import numpy as np
                observed = np.array(data_a)
                stat, p, dof, expected = stats.chi2_contingency(observed)
                print(json.dumps({"ok": True, "statistic": stat, "p_value": p, "dof": dof,
                                  "expected": expected.tolist()}))
                return
            else:
                print(json.dumps({"ok": False, "error": f"Unknown test: {test_name}"}))
                sys.exit(1)

            print(json.dumps({"ok": True, "test": test_name, "statistic": stat, "p_value": p}))

        elif op == "meta_analysis":
            import numpy as np
            import statsmodels.stats.meta_analysis as sma
            effects = payload["effects"]
            variances = payload["variances"]
            result = sma.combine_effects(effects, variances, method_moments="REML")
            summary = result.summary_frame()
            print(json.dumps({
                "ok": True,
                "pooled_effect": float(summary["eff"].iloc[0]),
                "ci_lower": float(summary["ci_low"].iloc[0]),
                "ci_upper": float(summary["ci_upp"].iloc[0]),
                "i2": float(result.i_squared) if hasattr(result, 'i_squared') else None,
                "tau2": float(result.tau2) if hasattr(result, 'tau2') else None,
            }))

        elif op == "power_analysis":
            from statsmodels.stats.power import TTestIndPower, TTestPower, NormalIndPower
            analysis_type = payload.get("analysis_type", "tt_ind")
            effect_size = payload.get("effect_size")
            alpha = payload.get("alpha", 0.05)
            power = payload.get("power")
            n_obs = payload.get("n_obs")

            if analysis_type == "tt_ind":
                analysis = TTestIndPower()
            elif analysis_type == "tt_1samp":
                analysis = TTestPower()
            else:
                analysis = NormalIndPower()

            if n_obs is None:
                n = analysis.solve_power(effect_size=effect_size, alpha=alpha, power=power)
                print(json.dumps({"ok": True, "required_n": float(n)}))
            else:
                pwr = analysis.solve_power(effect_size=effect_size, alpha=alpha, nobs1=n_obs)
                print(json.dumps({"ok": True, "achieved_power": float(pwr)}))

        elif op == "mcmc_sample":
            import numpy as np
            import pymc as pm
            model_spec = payload.get("model", {})
            draws = payload.get("draws", 500)
            tune = payload.get("tune", 500)
            chains = payload.get("chains", 2)

            with pm.Model() as model:
                # Simple Gaussian model: infer mu and sigma from data
                data = np.array(model_spec.get("data", [0]))
                mu = pm.Normal("mu", mu=model_spec.get("mu_prior", 0),
                               sigma=model_spec.get("mu_sigma_prior", 10))
                sigma = pm.HalfNormal("sigma", sigma=model_spec.get("sigma_prior", 1))
                pm.Normal("obs", mu=mu, sigma=sigma, observed=data)
                trace = pm.sample(draws=draws, tune=tune, chains=chains,
                                  progressbar=False, return_inferencedata=True)

            import arviz as az
            summary = az.summary(trace, var_names=["mu", "sigma"])
            print(json.dumps({
                "ok": True,
                "summary": summary.to_dict(),
                "r_hat_mu": float(summary.loc["mu", "r_hat"]),
                "r_hat_sigma": float(summary.loc["sigma", "r_hat"]),
            }))

        elif op == "r_metafor":
            effects = payload["effects"]
            variances = payload["variances"]
            r_script = f"""
library(metafor)
yi <- c({','.join(str(e) for e in effects)})
vi <- c({','.join(str(v) for v in variances)})
res <- rma(yi, vi, method="REML")
cat(sprintf('{{"ok":true,"estimate":%.6f,"ci_lb":%.6f,"ci_ub":%.6f,"I2":%.4f,"tau2":%.6f,"p_val":%.6f}}',
    res$b[1], res$ci.lb, res$ci.ub, res$I2, res$tau2, res$pval))
"""
            result = subprocess.run(["Rscript", "--vanilla", "-e", r_script],
                                    capture_output=True, text=True, timeout=60)
            if result.returncode != 0:
                print(json.dumps({"ok": False, "error": result.stderr.strip()}))
                sys.exit(1)
            # Parse the output (find last JSON-like block)
            stdout = result.stdout.strip()
            print(stdout)

        else:
            print(json.dumps({"ok": False, "error": f"Unknown operation: {op}"}))
            sys.exit(1)

    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
