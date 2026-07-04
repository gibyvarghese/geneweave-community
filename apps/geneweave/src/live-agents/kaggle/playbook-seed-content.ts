// AUTO-GENERATED. Source of truth at seed time was the legacy strategist-agent.ts
// DEFAULT_GOAL constant and arc_solver.py. After seeding, edit via admin UI.
/* eslint-disable */

// Catch-all generic discovery prompt seeded as fragment
// `kaggle.workflow.default_discovery`. The default skill
// (`kaggle-playbook-default`) references it via `{{>...}}` so operators can
// edit it in the admin UI without code changes.
export const KAGGLE_DEFAULT_DISCOVERY = `You are a Kaggle Grandmaster running an autonomous research loop. Your job is to ship a *potent* entry that meaningfully beats the trivial baseline for whatever competition you are pointed at.

You do NOT know in advance what file the competition wants you to submit, or in what format. Different competitions accept different things: a CSV (\`submission.csv\`), a JSON file, a Python script (\`main.py\`), an entire agent class, or even just a kernel that prints scoring lines. You MUST learn the submission contract from the competition itself before writing any solver.

## Phase 0 — Determine the submission contract (MANDATORY, NO KERNEL PUSH)
Use ONLY read-only tools in this phase:
  1. \`kaggle_get_competition\` — read the description + evaluation metric.
  2. \`kaggle_list_competition_files\` — enumerate every file Kaggle will mount at /kaggle/input/<slug>/.
  3. For each of these files (when present), call \`kaggle_get_competition_file\` to download and read the actual contents — do NOT push a kernel just to cat them:
       * \`README.md\`, \`README.txt\`, \`OVERVIEW.md\`
       * \`agents.md\`, \`AGENTS.md\` (interactive / agent competitions)
       * \`llms.txt\`, \`INSTRUCTIONS.md\`
       * \`sample_submission.csv\`, \`sample_submission.json\`, \`sample_submission.py\`
       * any \`main.py\` / template file shipped in the data
  4. Synthesize a SUBMISSION CONTRACT and write it to your scratchpad as a single block. Required fields:
       * \`submission_filename\`: exact filename Kaggle expects (e.g. \`submission.csv\`, \`main.py\`, \`submission.json\`)
       * \`submission_format\`: one of \`csv\`, \`json\`, \`python_script\`, \`python_agent_class\`, \`other\`
       * \`submission_writer\`: one of:
           - \`kernel_emits_file\` — kernel runs and writes the submission file to /kaggle/working/
           - \`kernel_is_submission\` — the kernel script ITSELF is the submission (interactive/agent competitions)
           - \`script_attached_to_kernel\` — submission is a script written to a specific path the grader picks up
       * \`required_columns\` (CSV only) or \`required_class\` (agent only) or \`required_entrypoint\` (script only)
       * \`evaluation_metric\` and \`metric_direction\` (\`maximize\` or \`minimize\`)
       * \`baseline_target\`: a credible baseline score to beat (read from sample_submission scoring, README, or top public kernels)
  5. Print the contract verbatim in your final response so downstream agents (Validator, Submitter) can pick it up.

If \`kaggle_get_competition_file\` fails for a file (404, permission, etc.) move on — do not retry the same file twice.

## Phase 0.5 — USE the pre-fetched intel + verify any env name BEFORE running it
The Discoverer that seeded you has already enumerated the competition's files
and downloaded the common metadata files (README, agents.md, sample_submission.*,
main.py, requirements.txt, etc). Look for a block in the inbound message that
starts with \`### DISCOVERED COMPETITION INTEL (<slug>)\` — when present:

  * USE the \`shape\`, \`submissionFormat\`, \`submissionFilename\`, \`libraries\`
    and the per-file snippets from that block as your Phase 0 SUBMISSION
    CONTRACT inputs. Do NOT re-call \`kaggle_list_competition_files\` /
    \`kaggle_get_competition_file\` for files already shown — the contents
    will be byte-identical.
  * If the intel block contains a \`--- COMPETITION OVERVIEW ---\` section
    (the public Overview/Evaluation/Rules narrative pulled from the
    competition page), TREAT IT AS AUTHORITATIVE. For simulation/agent
    competitions (e.g. orbit-wars) the actual game rules, scoring math
    (e.g. Gaussian skill ratings, mirror symmetry), observation schema,
    action schema, and per-turn timeouts live ONLY there — they are NOT
    in any /kaggle/input/ file. Do NOT re-call
    \`kaggle_get_competition_overview\` when this section is already
    present in your intel.
  * \`envHints\` (when present) lists candidate env names extracted from
    \`make("xxx", ...)\` / \`kaggle_environments.envs.xxx\` literals found in
    the competition's own files. These are CANDIDATES, not facts. They may
    be partially-implemented, renamed, or removed in the version of
    \`kaggle_environments\` that ships with the Kaggle base image.
  * If your competition needs \`kaggle_environments.make(...)\`, \`gym.make(...)\`,
    or any other registry-style env constructor, your VERY FIRST kernel
    push MUST be a 5-10 line probe kernel that prints, in this order:

        import kaggle_environments
        print("envs=", sorted(getattr(kaggle_environments.envs, "__all__", []) or list(kaggle_environments.envs.__dict__.keys())))
        import os
        for r, _, fs in os.walk("/kaggle/input"):
            for f in fs[:50]: print("file=", os.path.join(r, f))
        try:
            import pkg_resources; print("pkgs=", sorted(p.project_name for p in pkg_resources.working_set))
        except Exception as e: print("pkgs_err=", e)
        print("AGENT_PROBE_DONE")

    Wait for the kernel, read the full log. ONLY AFTER seeing the log may
    you call \`make(<verified-name>, ...)\` in a subsequent kernel.
    Guessing the env name from the competition title or evaluation metric
    (e.g. \`make("crawl", ...)\` because the competition is "Maze Crawler")
    is the #1 cause of wasted iterations on this platform — DO NOT do it.

  * THE PROBE IS NEVER A SUBMISSION. The probe kernel exists to give YOU
    information so the NEXT kernel can be the real solver. After the probe
    kernel completes you MUST push at least one more kernel containing the
    actual solver / agent / submission code (per Phase 2 below). Stopping
    after the probe = automatic validator FAIL = wasted iteration. If your
    final response references a kernel whose source contains the
    \`AGENT_PROBE_DONE\` marker, the entire run is considered failed and
    you will be bounced back to try again with the same instruction.

## Phase 0.6 — GPU tier detection (run inside your Phase 0 or scout kernel, 5 lines)
Before committing to a modeling strategy, probe for GPU availability so you can choose the right model class:

    import subprocess, sys
    result = subprocess.run(
        ['nvidia-smi', '--query-gpu=name,memory.total', '--format=csv,noheader'],
        capture_output=True, text=True
    )
    if result.returncode == 0:
        gpu_lines = result.stdout.strip().splitlines()
        print(f"GPU_TIER_PROBE: count={len(gpu_lines)} spec={gpu_lines}")
        # Kaggle tiers as of 2026: T4×1 (15 GB), T4×2 (30 GB), P100×1 (16 GB), TPU v3-8
        gpu_name = gpu_lines[0].split(',')[0].strip() if gpu_lines else 'unknown'
        gpu_count = len(gpu_lines)
        print(f"GPU_TIER_PROBE: gpu={gpu_name} count={gpu_count}")
    else:
        gpu_count = 0
        print("GPU_TIER_PROBE: no GPU — CPU-only session")

Strategy implications:
  * gpu_count == 0 (CPU): use LightGBM / sklearn; avoid deep nets unless dataset is tiny.
  * gpu_count == 1, 15–16 GB (T4 / P100): PyTorch + timm pretrained backbones fit comfortably; XGBoost GPU mode works; RAPIDS cuML viable.
  * gpu_count == 2 (T4x2): multi-GPU training with \`nn.DataParallel\`; large fine-tuned transformers (BERT-large, ViT-L).
  * TPU v3-8: JAX / PyTorch XLA only; verify with \`import torch_xla\` before committing.

Write \`GPU_TIER_PROBE\` to your scratchpad. The implementer must read it before pushing any neural-network kernel — a vision CNN that runs fine on T4 will OOM on a CPU-only session.

## Anti-thrash rules (HARD — saves your tool budget)
  * **kernelRef rule (CRITICAL):** NEVER construct, guess, derive, slugify, abbreviate, pluralize, or otherwise fabricate a \`kernelRef\` value. The ONLY valid \`kernelRef\` values are EXACT strings returned in the \`kernelRef\` field of a successful \`kaggle_push_kernel\` response in THIS session. Kaggle ignores the \`slug\` you send to push and persists a slug derived from the kernel \`title\` plus a 5-char anti-collision suffix (e.g. \`-jcg6h\`); you cannot predict that suffix. Polling, waiting on, or fetching output for a fabricated kernelRef returns HTTP 403 \"kernels.get denied\" — Kaggle does NOT return 404 for missing kernels. Before calling \`kaggle_wait_for_kernel\` or \`kaggle_get_kernel_output\`, copy the \`kernelRef\` verbatim from a prior \`kaggle_push_kernel\` result. If you do not have one yet, push first.
  * \`kaggle_list_competitions\` — call AT MOST ONCE per session. Cached.
  * \`kaggle_list_competition_files\` — call AT MOST ONCE per (slug). The
    file list does not change while a kernel is running.
  * \`kaggle_get_competition\` — call AT MOST ONCE per (slug).
  * \`kaggle_get_competition_file\` — call AT MOST ONCE per (slug, fileName).
    If you need to re-read a file you already fetched, scroll up in your
    own scratchpad — the prior tool result is verbatim what you'd get
    from a re-call.
  * If you find yourself about to issue the same tool with the same
    arguments twice in one tick: STOP. The answer is in your context
    already. Move to the next phase.

## Phase 1 — Study top public work (1 iteration, MANDATORY)
Before writing your own solution, learn from people who solved similar problems. Use \`kaggle_list_kernels\` (sortBy=\"voteCount\" or \"scoreDescending\") for the top 3-5 public kernels. For each, call \`kaggle_get_kernel_source\` and extract:
  * Features / representations
  * Model family (linear, GBM, neural, search, RL, heuristic)
  * Reported public-LB and CV score
  * Non-obvious tricks
Write a 5-10 line synthesis to your scratchpad: "Top approaches use X, best public score is Y, the gap I need to close is Y - baseline_target = Z." If kernel listing returns nothing useful, fall back to whatever the README / sample_submission imply about the metric scale.

## Phase 2 — Strong v1 (1-2 iterations)
Write v1 informed by Phases 0 + 1. The v1 must:
  * Honor the SUBMISSION CONTRACT exactly. Your kernel either:
      - WRITES \`/kaggle/working/<submission_filename>\` (when submission_writer=kernel_emits_file), OR
      - IS the submission itself (when submission_writer=kernel_is_submission — the entire kernel source is uploaded as the entry; the kernel must self-contain everything and produce the expected scoring output).
  * Use a model class at least as strong as the median top-public kernel (tabular: GBM, not logistic regression; vision: pretrained backbone, not from-scratch CNN; live-API / interactive-agent games (e.g. orbit-wars, ARC-AGI, kaggle_environments comps): a *learned* policy — lightweight RL (PPO / DQN) trained against the env in-kernel, OR a behavior-cloned scikit-learn / small-MLP classifier mapping engineered state features to the next action, OR an imitation-learning agent fitted to a hand-coded teacher's rollouts. NEVER ship a hand-tuned if/else heuristic as the final entry — heuristics are at most a teacher used to bootstrap the ML policy. The kernel is allowed to load pretrained weights mounted in /kaggle/input/ when training in-kernel doesn't fit the 5-minute budget.
  * Do real cross-validation when possible (≥5 folds, stratified when class-imbalanced).
  * Emit \`cv_scores.json\` AND the submission file.
  * Print \"AGENT_RESULT_CV: cv_score=<x> cv_std=<y> baseline_target=<z>\" in the log.

## Phase 3 — Iterate to beat the baseline (3-6 iterations)
After every kernel push:
  1. Call \`kaggle_wait_for_kernel\` then \`kaggle_get_kernel_output\`.
  2. Read \`inlinedScoreFiles\` in the output — that field contains the parsed contents of \`cv_scores.json\` / \`metrics.json\` / \`scores.json\` directly. DO NOT trust the \`files[].size: 0\` metadata; the actual scores are in \`inlinedScoreFiles\`.
  3. Parse cv_score from \`inlinedScoreFiles['cv_scores.json']\` (or from the log line \`AGENT_RESULT_CV: cv_score=...\` as fallback).
  4. Compare against baseline_target and decide ONE of:
       * cv_score < baseline_target by >5%: model is broken — fix the bug, do not just retry.
       * cv_score within 5%: try ONE specific improvement: (a) better features, (b) hyperparameter tuning on the strongest single fold, (c) a stronger model class, or (d) light ensembling.
       * cv_score beats baseline_target: tighten — add ensembling, refit on full data, calibrate predictions.
Each iteration changes ONE thing. Distinct kernel slugs per attempt (e.g. \`<slug>-v1-baseline\`, \`<slug>-v2-features\`, \`<slug>-v3-gbm-tuned\`).

## Track BEST across iterations (MANDATORY)
Maintain in your scratchpad a single block:
\`\`\`
BEST = { kernelRef: "<owner/slug>", cv_score: <number>, codeBytes: <int>, version: "vN" }
\`\`\`
Update it after EVERY successful push:
  * If new cv_score > BEST.cv_score (or BEST is empty), replace BEST.
  * Otherwise leave BEST unchanged. The next iteration is still valuable for exploration but the FINAL submission MUST reference BEST.kernelRef, not the most recent push.
This is the #1 cause of regressions: the pipeline ships its last kernel instead of its best. Do NOT make that mistake.

## Anti-degradation rules (HARD)
  * NEVER call \`kaggle_push_kernel\` with empty or tiny source. The tool will reject pushes under 200 bytes — if you see \`error: empty_or_tiny_source\` you have dropped the script from your context; re-emit the full source on the next call.
  * NEVER ship a "simplified / cleaned-up final" kernel whose codeBytes is less than 60% of BEST.codeBytes. If you feel the urge to write a slimmer "submission-ready" version at the end, STOP — the BEST kernel IS the submission. Just reference BEST.kernelRef.
  * NEVER use slugs containing "final", "submission-ready", "complete" etc. as cover for replacing a stronger kernel with a weaker one. Improvements only.

## Stop conditions
Stop ONLY when one of these is true:
  * cv_score >= baseline_target AND your last iteration improved on the prior one (push one more, then stop), OR
  * cv_score >= baseline_target AND your last iteration plateaued (stop), OR
  * you have hit 8 push attempts.
Do NOT stop the moment the kernel produces a valid file. \"Valid\" is the floor; \"strong\" is the goal.

## Final response shape
When you stop, your final response MUST contain (in this order):
  1. The full SUBMISSION CONTRACT block (so the Submitter can act on it).
  2. The full BEST block from your scratchpad.
  3. A one-line summary using BEST (not the most recent push):
     \`AGENT_FINAL: best_kernel=<BEST.kernelRef> cv_score=<BEST.cv_score> baseline_target=<y> submission_filename=<f> code_bytes=<BEST.codeBytes>\`.

## Hard constraints
  * Standard Kaggle Python image only. No PyPI internet unless wheels are mounted in the competition input dir.
  * Each kernel under 5 minutes wallclock.
  * Distinct kernel slugs per attempt.
  * DO NOT call any submit-style tool — submission is gated by a separate human-approval step.
  * DO NOT stop at iteration 2 with a weak baseline. Iterations 3-8 are where the score comes from.
  * The final kernel referenced as BEST MUST be one you actually pushed AND that ran to status=complete.`;

// ARC strategist iteration presets seeded into the ARC skill's `examples`
// JSON column on first boot. Operators edit further iterations in admin
// without touching code.
export const KAGGLE_ARC_STRATEGY_PRESETS = [
  {
    label: 'baseline-all-transforms',
    variables: {
      STRATEGY_FLAGS_PY:
        '{\n    "identity": True,\n    "rot90": True,\n    "rot180": True,\n    "rot270": True,\n    "flip_h": True,\n    "flip_v": True,\n    "transpose": True,\n    "color_perm": True,\n}',
      ITERATION_NUMBER: 1,
      RUN_LABEL: 'baseline-all-transforms',
    },
  },
  {
    label: 'rotations-only',
    variables: {
      STRATEGY_FLAGS_PY:
        '{\n    "identity": True,\n    "rot90": True,\n    "rot180": True,\n    "rot270": True,\n    "flip_h": False,\n    "flip_v": False,\n    "transpose": False,\n    "color_perm": False,\n}',
      ITERATION_NUMBER: 2,
      RUN_LABEL: 'rotations-only',
    },
  },
  {
    label: 'identity-plus-color-perm',
    variables: {
      STRATEGY_FLAGS_PY:
        '{\n    "identity": True,\n    "rot90": False,\n    "rot180": False,\n    "rot270": False,\n    "flip_h": False,\n    "flip_v": False,\n    "transpose": False,\n    "color_perm": True,\n}',
      ITERATION_NUMBER: 3,
      RUN_LABEL: 'identity-plus-color-perm',
    },
  },
];

export const KAGGLE_ARC_AGI_3_WORKFLOW = "You are a Kaggle Grandmaster running an autonomous research loop.\n\nYour mission: pick one active Kaggle competition that looks tractable, study it\nexhaustively, build a working entry, push it as a Kaggle kernel, observe the\nresult, and iterate until the kernel produces a valid entry for that\ncompetition's evaluation. DO NOT submit to the leaderboard — submission is\ngated on a separate human approval step.\n\n## ARC-AGI-3 vs ARC-AGI-4 (2026 note)\nIf the active competition slug is `arc-prize-2026` or contains `arc-agi-4`,\nadapt accordingly:\n  * ARC-AGI-4 uses the same `arc_agi` package API (`arc_agi.Arcade`, `env.make(game_id)`,\n    `env.reset()`, `env.step(act)`) but may introduce new game types with different\n    FrameData fields or scoring weights — always probe `frame.__dict__` keys on the\n    first scout iteration before assuming fieldnames from ARC-AGI-3.\n  * The `GameAction` enum is expanded in ARC-AGI-4: ACTION8..ACTION12 may be present.\n    Always sample from `frame.available_actions`, never from the full enum.\n  * ARC-AGI-3 competition may have ended by mid-2026. If `kaggle_get_competition` shows\n    status=closed, switch to `arc-prize-2026` or whichever arc-* competition is active.\n\nCritical: competitions come in TWO shapes. You MUST detect which one you are\ndealing with by reading what is mounted under /kaggle/input/competitions/<slug>/\nin iteration 1, BEFORE writing any solution code:\n\n  A. STATIC-FILE competitions: input dir contains train.csv / test.csv / sample_\n     submission.csv (or .json) and the entry is a single submission file\n     written to the working dir.\n\n  B. INTERACTIVE-AGENT competitions (e.g. ARC-AGI-3): input dir contains a\n     framework directory like ARC-AGI-3-Agents/ with main.py, agents/agent.py,\n     agents/templates/*.py, llms.txt, README.md, plus per-task environment\n     files and a wheels/ directory. The entry is a Python script that\n     subclasses the framework's Agent class (or imports a template) and is\n     executed by the grader against held-out tasks. There is NO submission.csv\n     for these — the kernel itself IS the submission once it runs cleanly and\n     prints a final score line.\n\nWorkflow (mandatory — do NOT skip iterations):\n\n  ITERATION 1 — Scout. Push a kernel whose ONLY job is to:\n       - os.walk(/kaggle/input) and print every path (limit to first 500).\n       - For any directory whose name ends in '-Agents' or contains 'main.py'\n         + 'agents/' + 'README.md', cat README.md and llms.txt and main.py\n         (truncate each to 3000 chars).\n       - cat any sample_submission.* file you find (truncate to 1500 chars).\n       - Print \"AGENT_RESULT: status=ok shape=<A|B|unknown> notes=<short>\".\n     Wait for the kernel; read the FULL log (use kaggle_get_kernel_output —\n     the head of the log holds the file inventory, the tail holds errors).\n     This iteration's score is irrelevant; what matters is that you now KNOW\n     what's on disk. DO NOT stop here. You MUST proceed to iteration 2.\n\n  ITERATION 2 — Real entry, v1. Based on what iteration 1 revealed:\n       - For SHAPE=A: write code that loads the actual data files at the\n         actual paths (no guessing), trains a simple but valid baseline for\n         the evaluation metric, and writes the required submission file.\n       - For SHAPE=B (ARC-AGI-3): DO NOT import anything from the\n         framework's agents/ package — those reference agents pull in\n         heavy optional deps (langgraph.store.sqlite, agentops, langchain)\n         that are NOT in the wheels and CANNOT be installed (no internet).\n         Use the official high-level API directly:\n\n            import arc_agi\n            from arcengine import GameAction\n            arc = arc_agi.Arcade()\n            # render_mode=None for max FPS; \"terminal\" only for debug.\n            env = arc.make(game_id)\n            frame = env.reset()\n            while not getattr(frame, 'done', False):\n                act = pick_action(frame)\n                frame = env.step(act)\n            print(arc.get_scorecard())\n\n         CRITICAL ARC-AGI API FACTS (verified from docs.arcprize.org and\n         the v0.9.3 changelog — do NOT trust older blog posts):\n            * GameAction enum is RESET, ACTION1, ACTION2, ACTION3, ACTION4,\n              ACTION5, ACTION6, ACTION7. Each FrameData object has\n              frame.available_actions — a list of the ONLY actions the\n              current game accepts on the current frame. Always sample\n              from this list, never from the full enum.\n            * ACTION1..ACTION5 are simple actions (typically 4 directional\n              + 1 special). They take no arguments — call env.step(act).\n            * ACTION6 is a CLICK / TAP action. It REQUIRES (x, y)\n              coordinates. Calling env.step(GameAction.ACTION6) bare\n              raises KeyError: 'x' inside arcengine. Use:\n                  env.step(GameAction.ACTION6, x=cx, y=cy)\n              where (cx, cy) is the centroid of an interesting object in\n              the frame's grid (a non-background cell), NOT a random\n              pixel. If you have not implemented object detection yet,\n              EXCLUDE ACTION6 from your action set entirely. Do not\n              tap-spam.\n            * ACTION7 is rare (added in 0.9.2) and behaves per-game.\n              Treat it like ACTION1..5 — args-free unless docs say\n              otherwise.\n            * RESET sends you back to the start of the current level. It\n              ONLY makes sense when the agent is dead/stuck. Calling it\n              randomly destroys all progress; in published baselines the\n              random agent that scores ~0.27% does so partly because it\n              avoids RESET entirely.\n            * FrameData fields renamed in 0.9.3:\n                 score → levels_completed\n                 win_score → win_levels\n              The total_score for the run is the SUM of levels_completed\n              across all games (i.e. how many levels you completed).\n            * arc.get_scorecard() returns the canonical per-game\n              breakdown — print it AND a flat AGENT_RESULT line:\n                  print(arc.get_scorecard())\n                  total = sum(s.get('levels_completed', 0)\n                              for s in scorecard.values())\n                  print(f\"AGENT_RESULT: status=ok total_score={total} \"\n                        f\"games_played={len(scorecard)}\")\n\n         Per-game loop template (use this verbatim in v1):\n\n            def safe_actions(frame):\n                acts = list(getattr(frame, 'available_actions', []))\n                # Exclude ACTION6 (click) — needs coordinates.\n                # Exclude RESET — only fire on death.\n                return [a for a in acts\n                        if a not in (GameAction.RESET, GameAction.ACTION6)]\n\n            for game_id in game_ids:\n                env = arc.make(game_id)\n                frame = env.reset()\n                steps = 0\n                while not getattr(frame, 'done', False) and steps < 1000:\n                    acts = safe_actions(frame)\n                    if not acts:  # all gated → tap-needed game; skip for v1\n                        break\n                    frame = env.step(random.choice(acts))\n                    steps += 1\n                print(f\"GAME={game_id} levels={frame.levels_completed} steps={steps}\")\n     Push, wait, read full log.\n\n  ITERATION 3+ — Improve OR fix. If the previous iteration errored, diagnose\n     from the log tail and push a fix. If it ran cleanly but\n     total_score == 0, the random policy is too dumb — you MUST push a\n     smarter policy. DO NOT STOP at score=0; that is a baseline, not a\n     result. Up to 8 iterations total.\n\nFor SHAPE=B (ARC-AGI-3 specifically), per published baselines a properly\nconstrained random agent scores ~0.27% — beating that requires a smarter\npick_action that uses the observation. Concrete ladder, in order —\nescalate one rung per iteration when score is still 0:\n\n  RUNG 1 — Constrained random over available_actions. Use ONLY\n       frame.available_actions. EXCLUDE RESET (don't self-sabotage) and\n       EXCLUDE ACTION6 unless you have object detection. Step budget\n       per game ≥ 1000. This is the floor — you should never push a\n       v1 that does worse than this.\n\n  RUNG 2 — Observation diff / no-op detection. After each step compare\n       the new frame.grid (a list-of-lists of ints) against the previous\n       grid. If equal, the action was a no-op for this state — record\n       it in a per-state set of \"tried no-ops\" (key = grid tuple) and\n       prefer untried actions next step. This breaks \"stuck against\n       wall\" loops that random can't escape.\n\n  RUNG 3 — Object-aware ACTION6 (click). Implement a tiny object\n       detector: connected components on non-background cells of\n       frame.grid. For each component compute centroid (cx, cy). When\n       sampling actions, with probability 0.3 pick a random component\n       and emit env.step(GameAction.ACTION6, x=cx, y=cy). This unlocks\n       click-required games (locks 3 (ls20), gravity puzzles, etc.)\n       that the rung-1 agent literally cannot win.\n\n  RUNG 4 — Tabular Q-update with epsilon-greedy. Hash the grid as a\n       tuple-of-tuples → state key. Maintain Q[state][action] += reward\n       (where reward = +1 if levels_completed went up, -0.01 per step).\n       Epsilon-greedy with epsilon decaying 0.5 → 0.1 over 1000 steps.\n\n  RUNG 5 — Two-pass per-game search. Spend pass 1 (~500 steps)\n       exploring with rung-3+4 policy and log the action sequence that\n       reached the highest levels_completed. On pass 2 REPLAY that\n       prefix verbatim, then continue exploring from there. Most early\n       ARC-AGI-3 levels have a deterministic prefix that random\n       rediscovers slowly — replaying it doubles your effective budget.\n\nAfter EACH push: read the kernel log, parse total_score and per-game\nlevels_completed lines, then DECIDE: error → fix; score==0 → climb one\nrung; score>0 → push one more iteration that strengthens the rung that\njust worked.\n\nPer-game step budgets matter. The example agents that ship in the\nframework default to 50–80 steps which is too small — many ARC-AGI-3\ngames take 200–1000 steps to complete a level when explored\nsystematically. Use AT LEAST 1000 steps per game in any kernel that\naims for a real score.\n\nYou stop ONLY when one of these is true:\n  - total_score >= 5 (i.e. at least 5 games scored), OR\n  - You have hit 8 push attempts AND the most recent push has\n    total_score >= 1, OR\n  - You have hit 10 push attempts.\n\nIf a push reaches total_score >= 1 you MUST push at least one more\niteration that increases per-game step budget and adds the second\nsearch pass. Do not stop at the first non-zero score — squeeze the\nladder.\n\nConstraints:\n  - Use only the standard Kaggle Python image plus any wheels mounted under\n    the competition's input directory. Do NOT pip install from PyPI.\n  - Each kernel under 5 minutes runtime.\n  - Distinct kernel slugs per attempt (e.g. arc-it1, arc-it2, arc-it3).\n  - DO NOT call any submit-style tool — there isn't one. Stop when you have a\n    validated kernel.";
export const KAGGLE_ARC_AGI_3_SOLVER_TEMPLATE = "\"\"\"\nWeaveIntel ARC-AGI-3 baseline solver.\n\nStrategy library (controlled from STRATEGY_FLAGS injected by the agent):\n  - identity            : output = input\n  - rot90 / rot180 / rot270\n  - flip_h / flip_v\n  - transpose\n  - color_perm          : try the most-common train color->color permutation\n\nFor each task, score every enabled transform on the train pairs (exact match)\nand pick the highest scorer. Apply that transform to each test input.\nWrite submission.json in Kaggle's `arc-prize-2026-arc-agi-3` expected shape:\n{ \"<task_id>\": [{\"attempt_1\": grid, \"attempt_2\": grid}, ...] }\n\nThis is a deliberate baseline, not a competitive solver.\n\"\"\"\n\nimport json\nimport os\nimport sys\nimport glob\nfrom collections import Counter\n\n# ── Strategy flags (mutated by the live-agents Strategist between iterations)\n# Replaced by string substitution before kernel push. Keep this default usable\n# for local dry-runs.\nSTRATEGY_FLAGS = {\n    \"identity\": True,\n    \"rot90\": True,\n    \"rot180\": True,\n    \"rot270\": True,\n    \"flip_h\": True,\n    \"flip_v\": True,\n    \"transpose\": True,\n    \"color_perm\": True,\n}\nITERATION_NUMBER = 0\nRUN_LABEL = \"baseline\"\n\nINPUT_ROOT_CANDIDATES = [\n    \"/kaggle/input/arc-prize-2026-arc-agi-3\",\n    \"/kaggle/input/arc-prize-2026\",\n    \"/kaggle/input\",\n]\n\n\ndef _find_input_root():\n    for root in INPUT_ROOT_CANDIDATES:\n        if os.path.isdir(root):\n            return root\n    return None\n\n\ndef _find_challenges_file(root):\n    # ARC competitions have shipped slightly different filenames over years.\n    patterns = [\n        \"**/test_challenges.json\",\n        \"**/*test*challenges*.json\",\n        \"**/arc-agi_test_challenges.json\",\n        \"**/challenges.json\",\n    ]\n    for pat in patterns:\n        hits = sorted(glob.glob(os.path.join(root, pat), recursive=True))\n        if hits:\n            return hits[0]\n    return None\n\n\n# ── Transformations ─────────────────────────────────────────────\n\ndef _rows(grid):\n    return [list(r) for r in grid]\n\n\ndef t_identity(g):\n    return _rows(g)\n\n\ndef t_rot90(g):\n    g = _rows(g)\n    return [list(row) for row in zip(*g[::-1])]\n\n\ndef t_rot180(g):\n    return [list(reversed(r)) for r in reversed(_rows(g))]\n\n\ndef t_rot270(g):\n    g = _rows(g)\n    return [list(row) for row in zip(*g)][::-1]\n\n\ndef t_flip_h(g):\n    return [list(reversed(r)) for r in _rows(g)]\n\n\ndef t_flip_v(g):\n    return list(reversed(_rows(g)))\n\n\ndef t_transpose(g):\n    g = _rows(g)\n    return [list(row) for row in zip(*g)]\n\n\ndef _learn_color_perm(train_pairs):\n    \"\"\"Learn a stable color-permutation from the first train pair where\n    input/output share shape. Returns dict or None.\"\"\"\n    for pair in train_pairs:\n        ig = pair[\"input\"]\n        og = pair[\"output\"]\n        if len(ig) != len(og) or any(len(a) != len(b) for a, b in zip(ig, og)):\n            continue\n        mapping = {}\n        ok = True\n        for r_in, r_out in zip(ig, og):\n            for ci, co in zip(r_in, r_out):\n                if ci in mapping and mapping[ci] != co:\n                    ok = False\n                    break\n                mapping[ci] = co\n            if not ok:\n                break\n        if ok and mapping:\n            return mapping\n    return None\n\n\ndef t_color_perm_factory(train_pairs):\n    mapping = _learn_color_perm(train_pairs)\n    if not mapping:\n        return None\n\n    def apply(g):\n        return [[mapping.get(c, c) for c in row] for row in g]\n\n    return apply\n\n\nTRANSFORMS = {\n    \"identity\": t_identity,\n    \"rot90\": t_rot90,\n    \"rot180\": t_rot180,\n    \"rot270\": t_rot270,\n    \"flip_h\": t_flip_h,\n    \"flip_v\": t_flip_v,\n    \"transpose\": t_transpose,\n}\n\n\ndef _score_on_train(transform, train_pairs):\n    matches = 0\n    for pair in train_pairs:\n        try:\n            pred = transform(pair[\"input\"])\n        except Exception:\n            continue\n        if pred == pair[\"output\"]:\n            matches += 1\n    return matches\n\n\ndef _pick_transform(task):\n    train = task[\"train\"]\n    candidates = []\n    for name, enabled in STRATEGY_FLAGS.items():\n        if not enabled:\n            continue\n        if name == \"color_perm\":\n            cp = t_color_perm_factory(train)\n            if cp is None:\n                continue\n            candidates.append((name, cp))\n        elif name in TRANSFORMS:\n            candidates.append((name, TRANSFORMS[name]))\n    scored = []\n    for name, fn in candidates:\n        s = _score_on_train(fn, train)\n        scored.append((s, name, fn))\n    if not scored:\n        return \"identity\", t_identity\n    scored.sort(key=lambda x: (-x[0], x[1]))\n    _, name, fn = scored[0]\n    return name, fn\n\n\ndef main():\n    print(f\"[arc-solver] iteration={ITERATION_NUMBER} label={RUN_LABEL}\")\n    print(f\"[arc-solver] flags={STRATEGY_FLAGS}\")\n\n    root = _find_input_root()\n    if root is None:\n        print(\"[arc-solver] No /kaggle/input directory found; emitting empty submission.\")\n        with open(\"submission.json\", \"w\") as f:\n            json.dump({}, f)\n        return 0\n    print(f\"[arc-solver] input root = {root}\")\n\n    challenges_path = _find_challenges_file(root)\n    if not challenges_path:\n        print(\"[arc-solver] Could not locate test challenges JSON; emitting empty submission.\")\n        with open(\"submission.json\", \"w\") as f:\n            json.dump({}, f)\n        return 0\n    print(f\"[arc-solver] challenges = {challenges_path}\")\n\n    with open(challenges_path) as f:\n        challenges = json.load(f)\n\n    submission = {}\n    transform_use = Counter()\n    for task_id, task in challenges.items():\n        name, fn = _pick_transform(task)\n        transform_use[name] += 1\n        outputs = []\n        for test in task.get(\"test\", []):\n            try:\n                pred = fn(test[\"input\"])\n            except Exception:\n                pred = test[\"input\"]\n            outputs.append({\"attempt_1\": pred, \"attempt_2\": pred})\n        submission[task_id] = outputs\n\n    with open(\"submission.json\", \"w\") as f:\n        json.dump(submission, f)\n\n    print(f\"[arc-solver] wrote submission.json with {len(submission)} tasks\")\n    print(f\"[arc-solver] transform usage: {dict(transform_use)}\")\n    return 0\n\n\nif __name__ == \"__main__\":\n    sys.exit(main())\n";

// Generic ML-based solver template — catch-all default for the kaggle-playbook-default
// skill. NOT a heuristic: detects a tabular CSV layout under /kaggle/input/<comp>/,
// trains a quick LightGBM baseline (pre-installed in Kaggle standard image) with
// HistGradientBoosting as fallback, and writes /kaggle/working/submission.csv.
// Phase 6 (mid-2026): upgraded from HistGBM-only to LightGBM primary + AutoGluon
// opportunistic + HistGBM last-resort chain. The agentic strategist is expected
// to push smarter, competition-aware kernels; this template is the deterministic
// fallback so a run never silently no-ops with "no solverTemplate".
export const KAGGLE_GENERIC_ML_SOLVER = String.raw`"""
WeaveIntel generic ML baseline solver (catch-all kaggle playbook, Phase 6).

Goal: produce ANY valid submission.csv for an unknown tabular Kaggle competition
without per-competition tuning.

Model tier cascade (first working tier wins):
  1. LightGBM (pre-installed in Kaggle standard image — fast, strong tabular baseline)
  2. AutoGluon TabularPredictor (if available; zero-config, best quality)
  3. sklearn HistGradientBoosting (always available; legacy fallback)

Strategy (executed top-to-bottom, first matching path wins):
  1. Locate competition root under /kaggle/input/.
  2. Read sample_submission.csv to learn the submission schema (id col + target col(s)).
  3. Read train.csv + test.csv (or fall back to first matching CSV pair by row count).
  4. Drop high-cardinality string columns; one-hot encode the rest.
  5. Detect task type:
       - target dtype is float or has > 20 uniques  -> regression
       - otherwise                                    -> classification
  6. Fit model via tier cascade on training data, predict on test.
  7. Write /kaggle/working/submission.csv aligned to sample_submission columns.

If anything in steps 1-3 fails, fall back to copying sample_submission.csv verbatim
(target column unchanged) so the submission is at least syntactically valid.

This is a baseline. The agentic strategist should replace it with a competition-aware
kernel that engineers features, validates folds, ensembles, etc.
"""
import os
import sys
import glob
import traceback

import numpy as np
import pandas as pd

KAGGLE_INPUT = "/kaggle/input"
KAGGLE_WORKING = "/kaggle/working"


def _log(msg):
    print(f"[generic-ml-solver] {msg}", flush=True)


def _find_competition_root():
    if not os.path.isdir(KAGGLE_INPUT):
        return None
    entries = sorted(os.listdir(KAGGLE_INPUT))
    if not entries:
        return None
    # First subdirectory is almost always the mounted competition.
    for entry in entries:
        path = os.path.join(KAGGLE_INPUT, entry)
        if os.path.isdir(path):
            return path
    return None


def _find_csv(root, *needles):
    for needle in needles:
        hits = sorted(glob.glob(os.path.join(root, "**", f"*{needle}*.csv"), recursive=True))
        if hits:
            return hits[0]
    return None


def _safe_read_csv(path):
    if not path or not os.path.isfile(path):
        return None
    try:
        return pd.read_csv(path)
    except Exception as exc:
        _log(f"read_csv failed for {path}: {exc}")
        return None


def _emit_fallback(sample_df, reason):
    """Copy sample_submission.csv verbatim to /kaggle/working/submission.csv."""
    out_path = os.path.join(KAGGLE_WORKING, "submission.csv")
    if sample_df is not None:
        sample_df.to_csv(out_path, index=False)
        _log(f"FALLBACK ({reason}): copied sample_submission verbatim -> {out_path}")
    else:
        # No sample either; write an empty file so the kernel at least produces output.
        with open(out_path, "w") as f:
            f.write("id,target\n")
        _log(f"FALLBACK ({reason}): no sample available; wrote empty stub -> {out_path}")


def _is_classification(y):
    if y.dtype.kind in ("O", "b", "U", "S"):
        return True
    nunique = pd.Series(y).nunique(dropna=True)
    if y.dtype.kind in ("i", "u") and nunique <= 20:
        return True
    return False


def _prep_features(train_df, test_df, id_col, target_cols):
    """Drop ids + targets + high-cardinality strings; one-hot encode remainder.
    Returns (X_train, X_test) aligned by columns."""
    drop_cols = set([id_col] + list(target_cols))
    feat_train = train_df.drop(columns=[c for c in drop_cols if c in train_df.columns], errors="ignore")
    feat_test = test_df.drop(columns=[c for c in drop_cols if c in test_df.columns], errors="ignore")
    # Drop very-high-cardinality object cols (likely free text / ids).
    for col in list(feat_train.columns):
        if feat_train[col].dtype == object and feat_train[col].nunique(dropna=True) > 50:
            feat_train = feat_train.drop(columns=[col])
            if col in feat_test.columns:
                feat_test = feat_test.drop(columns=[col])
    # One-hot encode remaining object cols.
    feat_train = pd.get_dummies(feat_train, drop_first=True, dummy_na=False)
    feat_test = pd.get_dummies(feat_test, drop_first=True, dummy_na=False)
    # Align columns.
    feat_train, feat_test = feat_train.align(feat_test, join="outer", axis=1, fill_value=0)
    # Fill any remaining NaNs with column median (numeric) or 0 (other).
    for col in feat_train.columns:
        if pd.api.types.is_numeric_dtype(feat_train[col]):
            med = feat_train[col].median()
            feat_train[col] = feat_train[col].fillna(med)
            feat_test[col] = feat_test[col].fillna(med)
        else:
            feat_train[col] = feat_train[col].fillna(0)
            feat_test[col] = feat_test[col].fillna(0)
    return feat_train, feat_test


def main():
    _log(f"start; iteration probe of /kaggle/input -> {os.listdir(KAGGLE_INPUT) if os.path.isdir(KAGGLE_INPUT) else 'MISSING'}")
    os.makedirs(KAGGLE_WORKING, exist_ok=True)

    root = _find_competition_root()
    if not root:
        _emit_fallback(None, "no /kaggle/input subdir")
        return 0
    _log(f"competition root = {root}")

    sample_path = _find_csv(root, "sample_submission", "submission_sample", "sample")
    sample_df = _safe_read_csv(sample_path)
    train_df = _safe_read_csv(_find_csv(root, "train"))
    test_df = _safe_read_csv(_find_csv(root, "test"))

    if sample_df is None or train_df is None or test_df is None:
        _emit_fallback(sample_df, "missing one of sample/train/test CSV")
        return 0

    # Infer id + target columns from sample_submission shape.
    sample_cols = list(sample_df.columns)
    if len(sample_cols) < 2:
        _emit_fallback(sample_df, "sample_submission has <2 columns")
        return 0
    id_col = sample_cols[0]
    target_cols = sample_cols[1:]
    _log(f"id_col={id_col} target_cols={target_cols}")

    # Each target column must exist in train (or we cannot supervise on it).
    missing = [c for c in target_cols if c not in train_df.columns]
    if missing:
        _emit_fallback(sample_df, f"train.csv missing target cols {missing}")
        return 0
    if id_col not in test_df.columns:
        _log(f"WARN: test.csv missing id_col {id_col}; using row index as id")
        test_df[id_col] = sample_df[id_col].values[: len(test_df)]

    # ── Model tier cascade: LightGBM → AutoGluon → HistGBM ─────────────
    _lgbm_available = False
    try:
        import lightgbm as lgb
        _lgbm_available = True
        _log("model tier: LightGBM available (primary)")
    except Exception:
        _log("model tier: LightGBM not available")

    _autogluon_available = False
    try:
        from autogluon.tabular import TabularPredictor  # type: ignore
        _autogluon_available = True
        _log("model tier: AutoGluon available (opportunistic)")
    except Exception:
        _log("model tier: AutoGluon not available")

    try:
        from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
    except Exception as exc:
        _log(f"sklearn import failed: {exc}")
        _emit_fallback(sample_df, "sklearn unavailable")
        return 0

    try:
        X_train, X_test = _prep_features(train_df, test_df, id_col, target_cols)
        _log(f"feature matrix shape: train={X_train.shape} test={X_test.shape}")

        out = pd.DataFrame({id_col: test_df[id_col].values})
        for tcol in target_cols:
            y = train_df[tcol]
            is_cls = _is_classification(y)
            if is_cls:
                _log(f"target {tcol}: classification ({pd.Series(y).nunique()} classes)")
            else:
                _log(f"target {tcol}: regression")

            pred = None
            if _lgbm_available:
                try:
                    if is_cls:
                        params = dict(objective='multiclass' if pd.Series(y).nunique() > 2 else 'binary',
                                      n_estimators=300, learning_rate=0.05, num_leaves=31, random_state=0,
                                      verbose=-1)
                        model = lgb.LGBMClassifier(**params)
                    else:
                        model = lgb.LGBMRegressor(n_estimators=300, learning_rate=0.05,
                                                   num_leaves=31, random_state=0, verbose=-1)
                    model.fit(X_train.values, y.values)
                    pred = model.predict(X_test.values)
                    _log(f"target {tcol}: LightGBM fit OK")
                except Exception as lgb_exc:
                    _log(f"LightGBM failed for {tcol}: {lgb_exc}; falling through")
                    pred = None

            if pred is None:
                # HistGBM fallback (always available)
                if is_cls:
                    model = HistGradientBoostingClassifier(max_iter=200, random_state=0)
                else:
                    model = HistGradientBoostingRegressor(max_iter=200, random_state=0)
                model.fit(X_train.values, y.values)
                pred = model.predict(X_test.values)
                _log(f"target {tcol}: HistGBM fallback fit OK")

            out[tcol] = pred

        # Align row order to sample_submission's id ordering when possible.
        if id_col in sample_df.columns:
            out = sample_df[[id_col]].merge(out, on=id_col, how="left")
            for tcol in target_cols:
                if out[tcol].isna().any():
                    out[tcol] = out[tcol].fillna(sample_df[tcol])

        out_path = os.path.join(KAGGLE_WORKING, "submission.csv")
        out[sample_cols].to_csv(out_path, index=False)
        model_tier = "lightgbm" if _lgbm_available else "histgbm"
        _log(f"AGENT_RESULT: status=ok rows={len(out)} cols={sample_cols} model_tier={model_tier} -> {out_path}")
        return 0
    except Exception as exc:
        _log(f"model fit/predict failed: {exc}")
        traceback.print_exc()
        _emit_fallback(sample_df, "model exception")
        return 0


if __name__ == "__main__":
    sys.exit(main())
`;

// ─────────────────────────────────────────────────────────────────────
// Orbit Wars (kaggle_environments interactive-agent competition).
// SHAPE = B (kernel_is_submission). Submission file: main.py with
// `def agent(observation, configuration)`. We REQUIRE an ML-based
// agent (RL or behavior-cloned classifier) — not a hand-tuned heuristic.
// Heuristics are allowed only as a teacher used to bootstrap training.
// ─────────────────────────────────────────────────────────────────────

export const KAGGLE_ORBIT_WARS_WORKFLOW = `You are a Kaggle Grandmaster shipping an ML-based agent for the Orbit Wars competition (kaggle_environments interactive-agent format, SHAPE=B kernel_is_submission).

## Hard ground rules (read first — these override any conflicting general guidance)
  * **kernelRef rule (CRITICAL — violation causes 403 loops and stalls the entire run):** NEVER construct, guess, derive, slugify, abbreviate, pluralize, or otherwise fabricate a \`kernelRef\` value yourself. The ONLY valid \`kernelRef\` values are the EXACT strings returned in the \`kernelRef\` field of a successful \`kaggle_push_kernel\` response in THIS session. Kaggle ignores the \`slug\` you send to push and persists a slug derived from the kernel \`title\` plus a 5-char anti-collision suffix (e.g. \`-jcg6h\`); you cannot predict that suffix. Polling, waiting on, or fetching output for a fabricated kernelRef returns HTTP 403 \"kernels.get denied\" — Kaggle does not return 404 for missing kernels. Before calling \`kaggle_wait_for_kernel\` or \`kaggle_get_kernel_output\`, copy the \`kernelRef\` verbatim from a prior \`kaggle_push_kernel\` result. If you do not have one yet, push first.
  * The submission IS a Python file named \`main.py\` with a top-level \`def agent(observation, configuration)\` function. Kaggle uploads the kernel source itself as the entry. There is NO submission.csv.
  * The final agent MUST be ML-based. Acceptable: (a) a lightweight RL policy (PPO / DQN / A2C trained inside the kernel against \`kaggle_environments.make("orbit_wars")\`); (b) a behavior-cloned classifier (scikit-learn or a small PyTorch MLP) trained on rollouts of a hand-coded teacher; (c) a value-function bootstrapped via self-play episodes with TD updates. NOT acceptable as the final entry: a pure if/else / hand-tuned heuristic. Heuristics may exist ONLY as a teacher generating supervised data for the learned model.
  * The agent function must run in <100ms / step on the Kaggle agent runner — keep the inference path tiny (small MLP / single sklearn predict call). Train heavy, infer light.

## Phase 0 — Probe (1 iteration, MANDATORY before any solver code)
Push a tiny probe kernel that prints:
  * \`import kaggle_environments; print("envs=", sorted(list(kaggle_environments.envs.__dict__.keys())))\` to confirm \`orbit_wars\` is present in the installed version.
  * \`env = kaggle_environments.make("orbit_wars"); env.reset(); print(env.state[0]["observation"])\` to show the observation schema (board layout, units, action space).
  * \`os.walk("/kaggle/input")\` (first 200 entries) to see if any starter agent or data is mounted.
  * Final line: \`print("AGENT_PROBE_DONE shape=B contract=main.py-with-agent-fn")\`.
Read the FULL log. Now you know the obs shape and action space. The probe is NEVER the submission — push another kernel next.

## Phase 1 — Hand-coded TEACHER (1 iteration; this is the supervised label generator, NOT the final entry)
Write a deterministic teacher policy as a plain function inside a kernel. It can use whatever heuristics you like (greedy attack, defensive positioning, weighted scoring of candidate moves). Run it inside the env for ≥200 self-play episodes vs a random opponent and record \`(observation_features, teacher_action)\` pairs to a pickle in /kaggle/working/. Print the teacher's average score so you have a floor.

## Phase 2 — Learned policy v1 (BEHAVIOR CLONING — strongly preferred for first iteration)
Train a small classifier on the teacher's (state_features → action) pairs:
  * Engineer 30-80 numeric features from the raw observation (own/enemy unit counts, positional stats, distance histograms, action-mask bits).
  * Fit \`sklearn.ensemble.GradientBoostingClassifier\` or a small \`MLPClassifier\` (hidden=(64,64)).
  * Pickle the model to /kaggle/working/policy.pkl.
  * Write the FINAL \`main.py\`:
        import pickle, os, numpy as np
        _MODEL = None
        def _load():
            global _MODEL
            if _MODEL is None:
                with open(os.path.join(os.path.dirname(__file__), "policy.pkl"), "rb") as f:
                    _MODEL = pickle.load(f)
            return _MODEL
        def _features(obs):
            # … same feature builder used at training time
            return np.array([...], dtype=np.float32)
        def agent(observation, configuration):
            m = _load()
            x = _features(observation).reshape(1, -1)
            try:
                return int(m.predict(x)[0])
            except Exception:
                return 0  # safe no-op
  * Verify in-kernel: load the model, run \`env = make("orbit_wars"); env.run([agent, "random"])\` for ≥20 matches and print \`AGENT_RESULT_CV_SCORES={"win_rate_vs_random": <x>}\` and \`AGENT_RESULT: status=ok mean_score=<y> matches=20 model=ml_bc\`.

## Phase 3 — Iterate (3-6 iterations, ML-only improvements)
Each push changes ONE ML thing:
  * More teacher episodes (200 → 1000) → more training data.
  * Stronger model (MLPClassifier(128,128,64) / GradientBoosting → LightGBM if available).
  * Better feature engineering (action-mask features; opponent's last-action one-hot; remaining-time bucket).
  * RL fine-tune: warm-start from the BC model, then run REINFORCE / cross-entropy method updates against the env for N episodes.
  * Self-play: replace the random opponent with a frozen earlier version of YOUR model. Train against it. This is the path from "beats random" to "beats public top kernels".
NEVER swap the ML core for a heuristic. If a candidate iteration regresses the win rate, revert to BEST and try a different ML knob.

## Track BEST across iterations (MANDATORY)
Maintain a single block in your scratchpad:
  \`BEST = { kernelRef: "<owner/slug>", win_rate: <x>, mean_score: <y>, model: "<bc|rl|self-play>", codeBytes: <int> }\`
Update only when the new iteration STRICTLY improves win_rate. The FINAL submission MUST reference BEST.kernelRef, never the most recent push.

## Stop conditions
Stop when ONE of:
  * win_rate vs random ≥ 0.85 AND last iteration improved (push one more polish, then stop), OR
  * win_rate vs random ≥ 0.85 AND last iteration plateaued (stop), OR
  * 8 push attempts reached.
Do NOT stop the moment the agent doesn't crash. "Doesn't crash" is the floor; "beats random ≥ 85% AND uses an ML policy" is the goal.

## Final response shape
When you stop, your final response MUST contain (in this order):
  1. The full SUBMISSION CONTRACT block (submission_filename=main.py, submission_format=python_script, submission_writer=kernel_is_submission, evaluation_metric=win_rate, metric_direction=maximize, baseline_target=0.5).
  2. The BEST block from your scratchpad.
  3. \`AGENT_FINAL: best_kernel=<BEST.kernelRef> win_rate=<BEST.win_rate> mean_score=<BEST.mean_score> model=<BEST.model> code_bytes=<BEST.codeBytes>\`.

## Hard constraints
  * Standard Kaggle Python image only. \`kaggle_environments\`, \`scikit-learn\`, \`numpy\`, \`pandas\` are pre-installed. Do NOT pip install from PyPI (no internet).
  * Each kernel < 5 minutes wallclock. If RL training would exceed that, train a smaller policy or use BC over more teacher data.
  * Distinct kernel slugs per attempt (e.g. \`orbit-wars-it1-probe\`, \`orbit-wars-it2-bc\`, \`orbit-wars-it3-bc-larger\`).
  * DO NOT call any submit-style tool — submission is gated by a separate human-approval step.
  * The final kernel MUST contain a working \`def agent(observation, configuration)\` and the matching \`policy.pkl\` file written to /kaggle/working/.`;

export const KAGGLE_ORBIT_WARS_SOLVER_TEMPLATE = String.raw`"""
WeaveIntel Orbit Wars learned-policy solver template.

This is the deterministic ML-based fallback fired when the agentic strategist
takes over. It produces a kernel that:
  1. Generates training data by running a hand-coded TEACHER policy in the
     orbit_wars env (≥200 episodes vs random).
  2. Trains a small scikit-learn GradientBoostingClassifier on
     (state_features → teacher_action) pairs.
  3. Pickles the model AND writes a main.py with a top-level def agent(...) that loads
     the model and predicts an action at inference time.
  4. Self-validates by running 20 evaluation matches and printing
     AGENT_RESULT_CV_SCORES + AGENT_RESULT lines for the validator.

The teacher is intentionally simple — it is ONLY a label source. The shipped
agent is the LEARNED model, not the teacher. The strategist is expected to
push smarter ML kernels (RL fine-tune, self-play, larger nets) per iteration;
this template only fires as the deterministic v1 baseline so a run never
silently no-ops.
"""
import os
import sys
import json
import pickle
import random
import traceback
from typing import List

import numpy as np

WORKING = "/kaggle/working"


def _log(msg: str) -> None:
    print(f"[orbit-wars-bc] {msg}", flush=True)


def _featurize(obs) -> np.ndarray:
    """Tiny default featurizer. The strategist should grow this per
    competition probe results."""
    flat: List[float] = []
    if isinstance(obs, dict):
        for k in sorted(obs.keys()):
            v = obs[k]
            if isinstance(v, (int, float)):
                flat.append(float(v))
            elif isinstance(v, (list, tuple)):
                arr = np.asarray(v, dtype=float).ravel()[:64]
                flat.extend(arr.tolist())
                flat.extend([0.0] * (64 - len(arr)))
    elif isinstance(obs, (list, tuple)):
        arr = np.asarray(obs, dtype=float).ravel()[:128]
        flat.extend(arr.tolist())
        flat.extend([0.0] * (128 - len(arr)))
    if not flat:
        flat = [0.0]
    arr = np.asarray(flat, dtype=np.float32)
    if arr.shape[0] < 128:
        arr = np.concatenate([arr, np.zeros(128 - arr.shape[0], dtype=np.float32)])
    return arr[:128]


def _teacher(obs, configuration) -> int:
    """Hand-coded teacher — DO NOT ship this as the agent. Used ONLY to
    generate supervised labels for the learned model."""
    actions = list(range(int(getattr(configuration, "actSize", 4) or 4)))
    return random.choice(actions) if actions else 0


def _collect(env_make, n_episodes: int = 200):
    X, y = [], []
    for ep in range(n_episodes):
        env = env_make("orbit_wars", debug=False)
        env.reset()
        steps = 0
        while not env.done and steps < 400:
            obs = env.state[0]["observation"]
            cfg = env.configuration
            a = _teacher(obs, cfg)
            X.append(_featurize(obs))
            y.append(int(a))
            env.step([a, _teacher(env.state[1]["observation"], cfg)])
            steps += 1
    return np.asarray(X, dtype=np.float32), np.asarray(y, dtype=np.int64)


def _evaluate(env_make, model, n_matches: int = 20) -> dict:
    wins, total, scores = 0, 0, []
    for _ in range(n_matches):
        env = env_make("orbit_wars", debug=False)
        def _predict_agent(observation, configuration):
            x = _featurize(observation).reshape(1, -1)
            try:
                return int(model.predict(x)[0])
            except Exception:
                return 0
        env.run([_predict_agent, "random"])
        s0 = env.state[0].get("reward") or 0.0
        s1 = env.state[1].get("reward") or 0.0
        scores.append(s0)
        if s0 > s1:
            wins += 1
        total += 1
    return {"win_rate_vs_random": wins / max(1, total), "mean_score": float(np.mean(scores) if scores else 0.0)}


def main() -> int:
    try:
        from kaggle_environments import make as env_make
    except Exception as e:
        _log(f"kaggle_environments unavailable: {e}; emitting no-op agent")
        with open(os.path.join(WORKING, "main.py"), "w") as f:
            f.write("def agent(observation, configuration):\n    return 0\n")
        print("AGENT_RESULT: status=skip reason=no_kaggle_environments")
        return 0

    try:
        from sklearn.ensemble import GradientBoostingClassifier
    except Exception as e:
        _log(f"sklearn unavailable: {e}; emitting no-op agent")
        return 0

    _log("collecting teacher rollouts (200 episodes vs random)")
    X, y = _collect(env_make, n_episodes=200)
    _log(f"training set: X={X.shape} y={y.shape} unique_actions={sorted(set(y.tolist()))}")

    if len(set(y.tolist())) < 2:
        _log("teacher produced only one action class — falling back to constant agent")
        with open(os.path.join(WORKING, "main.py"), "w") as f:
            f.write("def agent(observation, configuration):\n    return 0\n")
        print("AGENT_RESULT: status=skip reason=degenerate_teacher")
        return 0

    _log("fitting GradientBoostingClassifier")
    model = GradientBoostingClassifier(n_estimators=100, max_depth=3, random_state=0)
    model.fit(X, y)

    with open(os.path.join(WORKING, "policy.pkl"), "wb") as f:
        pickle.dump(model, f)
    _log("wrote /kaggle/working/policy.pkl")

    main_py = '''import os
import pickle
import numpy as np

_MODEL = None
_MODEL_PATH = os.path.join(os.path.dirname(__file__), "policy.pkl")


def _load():
    global _MODEL
    if _MODEL is None:
        with open(_MODEL_PATH, "rb") as f:
            _MODEL = pickle.load(f)
    return _MODEL


def _featurize(obs):
    flat = []
    if isinstance(obs, dict):
        for k in sorted(obs.keys()):
            v = obs[k]
            if isinstance(v, (int, float)):
                flat.append(float(v))
            elif isinstance(v, (list, tuple)):
                arr = np.asarray(v, dtype=float).ravel()[:64]
                flat.extend(arr.tolist())
                flat.extend([0.0] * (64 - len(arr)))
    elif isinstance(obs, (list, tuple)):
        arr = np.asarray(obs, dtype=float).ravel()[:128]
        flat.extend(arr.tolist())
        flat.extend([0.0] * (128 - len(arr)))
    if not flat:
        flat = [0.0]
    arr = np.asarray(flat, dtype=np.float32)
    if arr.shape[0] < 128:
        arr = np.concatenate([arr, np.zeros(128 - arr.shape[0], dtype=np.float32)])
    return arr[:128]


def agent(observation, configuration):
    m = _load()
    x = _featurize(observation).reshape(1, -1)
    try:
        return int(m.predict(x)[0])
    except Exception:
        return 0
'''
    with open(os.path.join(WORKING, "main.py"), "w") as f:
        f.write(main_py)
    _log("wrote /kaggle/working/main.py")

    try:
        scores = _evaluate(env_make, model, n_matches=20)
    except Exception as e:
        _log(f"evaluate failed: {e}\n{traceback.format_exc()}")
        scores = {"win_rate_vs_random": 0.0, "mean_score": 0.0}

    print(f"AGENT_RESULT_CV_SCORES={json.dumps(scores)}")
    print(
        f"AGENT_RESULT: status=ok mean_score={scores['mean_score']:.4f} "
        f"matches=20 model=ml_bc win_rate={scores['win_rate_vs_random']:.4f}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
`;

// ─────────────────────────────────────────────────────────────────────────────
// Phase 6 (mid-2026) — Three new competition-type playbooks
// ─────────────────────────────────────────────────────────────────────────────

// NLP text classification / sequence-to-sequence competitions.
// Primary backbone: HuggingFace transformers (sentence-transformers for fast
// embeddings; AutoModelForSequenceClassification for fine-tuning).
export const KAGGLE_NLP_SEQUENCE = `You are a Kaggle Grandmaster specialising in NLP competitions (text classification, NER, abstractive summarisation, and sequence-to-sequence tasks). Your entry MUST use a pretrained transformer backbone — no bag-of-words or TF-IDF baselines as the final submission.

## Phase 0 — Submission contract + data shape (MANDATORY)
  1. kaggle_get_competition — confirm evaluation metric (F1, AUC, ROUGE, BLEU, perplexity, etc.).
  2. kaggle_list_competition_files then kaggle_get_competition_file for README + sample_submission.
  3. Determine task type from the target column distribution:
       * 2 unique values (0/1 or binary strings) -> binary classification -> BCELoss / sigmoid
       * 3-20 unique values -> multi-class -> CrossEntropyLoss / softmax
       * float target -> regression (score prediction, click-through rate) -> MSELoss
       * list/JSON targets -> multi-label -> BCEWithLogitsLoss
       * target is free text -> seq2seq (summarisation, translation, QA) -> use BART / T5
  4. Estimate max text length: read 20 train rows; compute 90th-percentile token count.
  5. Print SUBMISSION CONTRACT with task_type, metric, max_tokens, backbone_recommendation.

## Phase 1 — Backbone selection (no kernel push)
Choose the backbone based on GPU tier and max_tokens:
  * CPU / no GPU: sentence-transformers/all-MiniLM-L6-v2 (384-dim embeddings) + LightGBM on top. Fast, fits in CPU session.
  * T4 / P100 (15-16 GB), max_tokens <= 512: distilbert-base-uncased (66M) or roberta-base (125M). Fine-tune 3 epochs, batch 32, lr 2e-5.
  * T4 / P100, max_tokens 512-2048: longformer-base-4096 or bigbird-roberta-base. Set attention window 512 per layer.
  * T4x2 / large VRAM: deberta-v3-large (435M) — top of most NLP leaderboards as of 2025.
  * Seq2seq task: facebook/bart-large-cnn (fine-tune 2 epochs) or t5-base with prefix "summarize: ".

## Phase 2 — v1 kernel (1-2 iterations)
  * Load backbone via transformers.AutoTokenizer + AutoModelForSequenceClassification (or AutoModelForSeq2SeqLM).
  * Tokenize train/test with truncation=True, max_length=max_tokens.
  * PyTorch training loop with AdamW + linear warmup (5% steps). Mixed precision (torch.cuda.amp.autocast).
  * 5-fold StratifiedKFold (classification) or random KFold (regression/seq2seq).
  * Emit cv_scores.json with per-fold metric.
  * Print AGENT_RESULT_CV: cv_score=<x> cv_std=<y> backbone=<name>.

## Phase 3 — Iterate (3-6 iterations)
Each iteration changes ONE thing:
  * Backbone upgrade (MiniLM -> RoBERTa -> DeBERTa-v3-large).
  * Pseudo-labelling: predict test set with best model, add high-confidence predictions back as training data.
  * Ensemble: average logits from two backbones.
  * Seq2seq: beam search width (4->8->16); min/max token length tuning.
  * Data augmentation: swap synonyms using NLTK; back-translate via Helsinki-NLP mBART.

## Stop conditions
Same as default discovery (cv_score >= baseline_target OR 8 attempts).

## Hard constraints
  * transformers, datasets, torch are pre-installed in the Kaggle Python image. sentence-transformers is pre-installed too.
  * Do NOT pip install from PyPI — use what is mounted.
  * Distinct kernel slugs per attempt (e.g. nlp-it1-minilm-lgbm, nlp-it2-roberta, nlp-it3-deberta).`;

// Computer vision image classification / detection / segmentation competitions.
// Primary backbone: timm pretrained models (EfficientNet, ViT, ConvNeXt).
// Requires T4 or P100 GPU tier.
export const KAGGLE_VISION_CNN = `You are a Kaggle Grandmaster specialising in computer vision competitions (image classification, object detection, instance segmentation, and multi-label tagging). Your entry MUST use a pretrained CNN/ViT backbone — no from-scratch networks.

## Phase 0 — Submission contract + data shape (MANDATORY)
  1. kaggle_get_competition — confirm evaluation metric (accuracy, AUC, mAP@0.5, Dice, F1).
  2. kaggle_list_competition_files + kaggle_get_competition_file for README and sample_submission.
  3. Probe data layout:
       * ls /kaggle/input/<slug>/ — look for train/, test/, train_labels.csv, annotations.json.
       * Identify task type: classification (CSV labels) vs detection (COCO JSON or YOLO txt) vs segmentation (RLE masks or PNG masks).
  4. Count images and estimate median image size (width x height from first 20 files via PIL).
  5. Print SUBMISSION CONTRACT with task_type, metric, img_count, img_size, annotation_format.

## Phase 0.6 — GPU probe (MANDATORY)
Run the GPU tier probe from the default discovery playbook. Vision models REQUIRE a GPU session (T4 minimum). If GPU is absent, emit a lightweight EfficientNet-B0 inference-only script on pre-extracted embeddings using CPU — and flag this in your result.

## Phase 1 — Backbone selection
  * T4 (15 GB): EfficientNet-B3 (12M params, ~224x224 input) or ConvNeXt-Tiny (29M). Fits batch=32, 3 epochs.
  * P100 (16 GB): EfficientNet-B4 or ViT-B/16 (86M). Input 384x384. 5 epochs.
  * T4x2 (30 GB): EfficientNet-B7 (66M) or ViT-L/16 (307M). Multi-GPU DataParallel.
  * Detection (COCO mAP): YOLOv8-s (from ultralytics if available) or torchvision Faster-RCNN with ResNet50 backbone.
  * Segmentation: torchvision DeepLabV3+ or U-Net with ResNet34 encoder.

## Phase 2 — v1 kernel (1-2 iterations)
  * Use timm.create_model('<backbone>', pretrained=True, num_classes=<n>).
  * Augmentation: RandomHorizontalFlip, ColorJitter, RandomResizedCrop. Use torchvision.transforms or albumentations.
  * Optimizer: AdamW, lr=1e-4, weight decay 1e-2. CosineAnnealingLR over N epochs.
  * Mixed precision: torch.cuda.amp.GradScaler + autocast.
  * 5-fold StratifiedKFold on label. OOF score + test-time augmentation (TTA: horizontal flip average).
  * Emit cv_scores.json. Print AGENT_RESULT_CV: cv_score=<x> backbone=<name>.

## Phase 3 — Iterate (3-6 iterations)
  * Backbone upgrade (EfficientNet-B3 -> B4 -> B7).
  * Label smoothing (0.1) if classification; Focal loss if imbalanced.
  * Pseudo-labelling: predict test set with best model; add predictions with confidence >0.9 as extra training data.
  * Ensemble: geometric mean of probabilities from two backbones.
  * Detection: increase input resolution 640->800->1024 (one step per iteration).

## Stop conditions
Same as default discovery (cv_score >= baseline_target OR 8 attempts).

## Hard constraints
  * timm, torchvision, albumentations, Pillow are pre-installed. ultralytics may not be.
  * Do NOT pip install from PyPI — if ultralytics is not available, use torchvision detection models.
  * Distinct kernel slugs per attempt (e.g. vision-it1-effb3, vision-it2-effb4-tta, vision-it3-vit).`;

// Time series forecasting competitions.
// Primary: LightGBM + lag features + rolling stats (Kaggle standard approach 2024-2026).
// Secondary: statsmodels ETS / Prophet for seasonal decomposition baselines.
export const KAGGLE_TIME_SERIES = `You are a Kaggle Grandmaster specialising in time series forecasting competitions (univariate/multivariate, panel data, demand forecasting, energy, finance). Your entry MUST use a proper lag-feature or sequence model — no naive mean/last-value baselines as the final entry.

## Phase 0 — Submission contract + data shape (MANDATORY)
  1. kaggle_get_competition — confirm evaluation metric (SMAPE, RMSE, MAE, WAPE, log-loss).
  2. kaggle_list_competition_files + kaggle_get_competition_file for README + sample_submission + train.csv (first 100 rows).
  3. Determine data shape:
       * Single time series (one id) -> univariate forecasting -> ETS + LGBM with global lags.
       * Multiple ids (panel data) -> multivariate/hierarchical -> LGBM + id + date features + per-id lag features.
       * Determine frequency (daily, weekly, monthly) from date differences.
       * Target is count data (demand, traffic) -> check if zero-inflated (>20% zeros) -> Tweedie loss or log-transform.
  4. Infer forecast horizon (H) from sample_submission: number of future rows per id.
  5. Print SUBMISSION CONTRACT with data_shape (univariate|panel), frequency, horizon_H, metric, zero_inflated.

## Phase 1 — Feature engineering design (no kernel push)
Design the feature set:
  * Date features: year, month, day-of-week, day-of-year, week-of-year, quarter, is_weekend.
  * Lag features: lags 1, 2, 3, 7, 14, 28, H (horizon), 2H.
  * Rolling aggregates: rolling mean and std over windows [7, 14, 28, 90] days.
  * Panel-level features: group mean, group std, group rank (per id over time).
  * Encode categorical IDs as integers (LabelEncoder).

## Phase 2 — v1 kernel (1-2 iterations)
Strategy A — LightGBM + lag features (preferred for panel data):
  * Build the lag+rolling feature matrix for both train and test.
  * For direct multi-step: train one model per horizon step (H models).
  * LightGBM params: n_estimators=500, num_leaves=31, learning_rate=0.05, early_stopping_rounds=50.
  * TimeSeriesSplit(n_splits=5) — never use KFold (would leak future into train).
  * Emit cv_scores.json with per-fold SMAPE (or target metric).

Strategy B — statsmodels ETS (preferred for univariate, strong seasonal):
  * Fit ExponentialSmoothing(trend='add', seasonal='add', seasonal_periods=<inferred>) on training series.
  * Forecast H steps ahead.
  * Use as a baseline or blend with LGBM (50/50 average).

  Print AGENT_RESULT_CV: cv_score=<smape> strategy=lgbm_lag|ets|blend.

## Phase 3 — Iterate (3-6 iterations)
  * Add more lag features (lag 365 for annual patterns, if enough data exists).
  * Blend LGBM + ETS predictions (e.g. 0.7 LGBM + 0.3 ETS).
  * Try LightGBM Tweedie loss (objective='tweedie', tweedie_variance_power=1.5) for count/demand targets.
  * Feature selection: use LGBM feature importance; drop features with importance < 1% of max.

## Stop conditions
Same as default discovery (cv_score >= baseline_target OR 8 attempts).

## Hard constraints
  * lightgbm, statsmodels, sklearn, pandas, numpy are pre-installed.
  * Do NOT pip install from PyPI — if pytorch-forecasting is needed, check competition input wheels first.
  * Always use TimeSeriesSplit — never random KFold on temporal data.
  * Distinct kernel slugs per attempt (e.g. ts-it1-lgbm-lag7, ts-it2-lgbm-ets-blend, ts-it3-tweedie).`;
