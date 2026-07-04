// CSS styles for geneWeave UI
// This is embedded in the HTML as a <style> tag
//
// geneWeave design tokens are generated from @weaveintel/tokens (the single source of truth shared with
// the native app) into TOKENS_CSS at BUILD time (scripts/gen-tokens-css.mjs) — a plain string, so this
// browser-served module never bare-imports the workspace package. TOKENS_CSS defines `--gw-*` (colours/
// space/radii/fonts/type + breakpoints) for light, dark, and the Creative variant, plus legacy
// `--bg`/`--accent`/… aliases → `--gw-*`, so the stylesheet + the per-tenant appearance override read
// from ONE place. It's placed right after the font @import; the app's own `:root` (identical values)
// still wins by cascade — zero visual change until each rule migrates to `var(--gw-*)`.
import { TOKENS_CSS } from './tokens.generated.js';

export const STYLES = `@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&family=Caveat:wght@500;600;700&family=Kalam:wght@400;700&family=Patrick+Hand&family=Gochi+Hand&display=swap');
${TOKENS_CSS}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
/* geneWeave design system — "color encodes agency": neutrals = you, emerald/mint = the AI.
   Token names are kept stable (--bg/--fg/--accent…) and remapped to the design palette so the
   whole app adopts the language; new semantic tokens (--mint/--ink/--coral…) are added alongside. */
:root{
  /* neutrals */
  --bg:#F6F8F7;            /* canvas — app background (Pro) */
  --bg2:#FFFFFF;           /* surface — cards, panels, rails */
  --bg3:#F0F2F1;           /* subtle fill — toggle tracks, resting chips */
  --bg4:#E7ECEA;           /* hairline — borders, dividers */
  --fg:#14201B;            /* ink — primary text */
  --fg2:#5E6E67;           /* muted — secondary text, labels, resting icons */
  --fg3:#9AA7A1;           /* placeholder — hints, disabled glyphs */
  /* signal — emerald encodes the assistant + primary action */
  --accent:#0E9A6E;        /* emerald */
  --accent2:#0B7A57;       /* emerald-press — pressed/active, text on mint */
  --accent-dim:#E8F5EE;    /* mint — AI surfaces, agent bubbles, active rows */
  --mint:#E8F5EE;--mint-deep:#DCEFE5;--mint-border:#BEE3D2;--mint-wash:#F4FBF7;
  --ink:#14201B;--muted:#5E6E67;--hairline:#E7ECEA;--canvas:#F6F8F7;--paper:#FBF8F1;--surface:#FFFFFF;
  /* attention / human ink (used sparingly) */
  --amber:#D98A3D;--coral:#D85A30;
  --hl-amber:#FAC775;--hl-pink:#F4C0D1;--hl-teal:#9FE1CB;--hl-blue:#B5D4F4;
  --diff-add-bg:#E8F5EE;--diff-add-fg:#14201B;--diff-del-bg:#FBEFEA;--diff-del-fg:#9C6B5C;
  --danger-zone-bg:#FCF7F2;--danger-zone-border:#F0E0D5;--danger-zone-fg:#A8551F;
  --solid:#14201B;--solid-hover:#24382F;--solid-contrast:#FFFFFF;
  --danger:#D85A30;--success:#0E9A6E;--warn:#D98A3D;
  --radius:12px;--radius-lg:16px;
  --font:'Inter',system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  --font-display:'Plus Jakarta Sans','Inter',sans-serif;
  --mono:'JetBrains Mono',SFMono-Regular,Menlo,Consolas,monospace;
  --font-hand:'Caveat',cursive;
  --shadow-soft:0 1px 3px rgba(20,32,27,.06);
  --shadow-hover:0 2px 8px rgba(20,32,27,.10),0 14px 28px rgba(20,32,27,.10);
  --shadow-pop:0 8px 28px rgba(20,32,27,.12);
}
html[data-theme='dark']{
  --bg:#0E1714;--bg2:#15201C;--bg3:#1B2723;--bg4:#2A3833;
  --fg:#E8EFEB;--fg2:#AEC2B9;--fg3:#7C928A;
  --accent:#2FD39B;--accent2:#3FE0A8;--accent-dim:#16332A;
  --mint:#16332A;--mint-deep:#1C3F33;--mint-border:#2A5A47;--mint-wash:#11271F;
  --ink:#E8EFEB;--muted:#AEC2B9;--hairline:#2A3833;--canvas:#0E1714;--paper:#141E18;--surface:#15201C;
  --diff-add-bg:#16332A;--diff-add-fg:#E8EFEB;--diff-del-bg:#3A201A;--diff-del-fg:#D4A595;
  --danger-zone-bg:#241A14;--danger-zone-border:#3A2A1E;--danger-zone-fg:#E0A87F;
  --solid:#2A453B;--solid-hover:#345449;--solid-contrast:#E8EFEB;
  --danger:#F08A60;--success:#2FD39B;--warn:#E0A87F;
  --shadow-soft:0 1px 2px rgba(0,0,0,.35);
  --shadow-hover:0 2px 8px rgba(0,0,0,.45),0 16px 32px rgba(0,0,0,.45);
  --shadow-pop:0 8px 28px rgba(0,0,0,.5);
}
html,body{height:100%;font-family:var(--font);background:var(--bg);color:var(--fg);-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}
button{font-family:inherit;cursor:pointer;border:none;outline:none;background:none}
input{font-family:inherit;outline:none}

/* ── Auth ───────────────────────────────────── */
.auth-wrap{display:flex;align-items:center;justify-content:center;height:100vh;background:var(--bg)}
.auth-card{background:var(--bg2);border:1px solid var(--bg4);border-radius:var(--radius-lg);padding:40px;width:400px;box-shadow:var(--shadow-soft)}
.auth-card h1{font-size:24px;font-weight:700;margin-bottom:4px;display:flex;align-items:center;gap:8px;color:var(--fg)}
.auth-card h1 span{color:var(--accent)}
.auth-card p.sub{color:var(--fg3);font-size:14px;margin-bottom:24px}
.auth-card .field{margin-bottom:16px}
.auth-card label{display:block;font-size:13px;color:var(--fg2);margin-bottom:6px;font-weight:500}
.auth-card input{width:100%;padding:12px 14px;border-radius:var(--radius);border:1px solid var(--bg4);background:var(--bg2);color:var(--fg);font-size:14px;transition:border-color .18s ease}
.auth-card input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(37,99,235,.1)}
.auth-card .btn{width:100%;padding:12px;border-radius:999px;background:var(--solid);color:var(--solid-contrast);font-weight:600;font-size:14px;margin-top:8px;transition:background .18s ease}
.auth-card .btn:hover{background:var(--solid-hover)}
.auth-card .divider{margin:16px 0;display:flex;align-items:center;gap:8px;font-size:12px;color:var(--fg3)}
.auth-card .divider .line{flex:1;height:1px;background:var(--bg4)}
.auth-card .oauth-btns{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}
.auth-card .oauth-btn{display:flex;align-items:center;justify-content:center;gap:6px;padding:10px 12px;border:1px solid var(--bg4);border-radius:var(--radius);background:var(--bg3);color:var(--fg2);font-weight:600;font-size:12px;transition:all .18s ease;cursor:pointer}
.auth-card .oauth-btn:hover{background:var(--bg4);border-color:var(--fg3);color:var(--fg)}
.auth-card .toggle{text-align:center;margin-top:16px;font-size:13px;color:var(--fg3)}
.auth-card .toggle a{cursor:pointer;color:var(--accent);font-weight:500}
.auth-card .err{color:var(--danger);font-size:13px;margin-top:8px;min-height:18px}

/* ── Layout ─────────────────────────────────── */
.app{display:flex;height:100vh;overflow:hidden;background:var(--bg)}
.sidebar{width:280px;background:var(--bg2);border-right:1px solid var(--bg4);display:flex;flex-direction:column}
.sidebar-hdr{padding:20px;border-bottom:1px solid var(--bg4);display:flex;align-items:center;justify-content:space-between}
.sidebar-hdr h2{font-size:16px;font-weight:700;display:flex;align-items:center;gap:6px;color:var(--fg)}
.sidebar-hdr h2 span{color:var(--accent)}
.new-chat-btn{padding:8px 16px;border-radius:999px;background:var(--solid);color:var(--solid-contrast);font-size:13px;font-weight:600;transition:background .18s ease}
.new-chat-btn:hover{background:var(--solid-hover)}
.chat-list{flex:1;overflow-y:auto;padding:8px 12px}
.chat-item{padding:10px 14px;border-radius:var(--radius);font-size:14px;color:var(--fg2);cursor:pointer;display:flex;justify-content:space-between;align-items:center;transition:all .18s ease}
.chat-item:hover{background:var(--bg3)}
.chat-item.active{background:var(--solid);color:var(--solid-contrast)}
.chat-item .del{opacity:0;color:var(--fg3);font-size:16px;padding:0 4px;transition:opacity .18s}
.chat-item:hover .del{opacity:1}
.chat-item.active .del{color:rgba(255,255,255,.6)}
.chat-item .del:hover{color:var(--danger)}
.sidebar-footer{padding:16px 20px;border-top:1px solid var(--bg4);display:flex;justify-content:space-between;align-items:center;font-size:13px;color:var(--fg3)}
.sidebar-footer .user-email{max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nav-btn{padding:6px 14px;border-radius:999px;font-size:12px;color:var(--fg2);background:var(--bg3);border:1px solid var(--bg4);font-weight:500;transition:all .18s ease}
.nav-btn:hover{background:var(--bg);border-color:var(--fg3);color:var(--fg)}
.nav-btn.active{background:var(--solid);color:var(--solid-contrast);border-color:var(--solid)}
.logout-btn{padding:6px 14px;border-radius:999px;font-size:12px;color:var(--danger);background:var(--bg3);border:1px solid var(--bg4)}
.logout-btn:hover{background:rgba(220,38,38,.06);border-color:var(--danger)}

/* ── Main content area ──────────────────────── */
.main{flex:1;display:flex;flex-direction:column;overflow:hidden;background:var(--bg)}
.main-header{padding:18px 22px 0;flex:0 0 auto}

/* ── Workspace shell (new UI) ───────────────── */
.workspace-nav{width:252px;background:var(--bg2);border-right:1px solid var(--bg4);padding:20px 14px;display:flex;flex-direction:column;gap:18px;transition:width .18s ease,padding .18s ease;height:100vh;min-height:100vh;max-height:100vh;overflow:hidden}
.workspace-nav.collapsed{width:74px;padding:20px 10px}
.workspace-nav-scroll{display:flex;flex-direction:column;gap:18px;flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;scrollbar-gutter:stable;overscroll-behavior:contain}
.workspace-nav-scroll::-webkit-scrollbar{width:11px}
.workspace-nav-scroll::-webkit-scrollbar-track{background:color-mix(in oklab,var(--bg4) 45%, transparent);border-radius:999px}
.workspace-nav-scroll::-webkit-scrollbar-thumb{background:color-mix(in oklab,var(--fg2) 55%, var(--bg4));border-radius:999px;border:2px solid var(--bg2)}
.workspace-nav-scroll::-webkit-scrollbar-thumb:hover{background:var(--fg2)}
.sidebar-scroll-controls{display:flex;align-items:center;gap:6px;margin-top:-8px}
.sidebar-scroll-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:8px;border:1px solid var(--bg4);background:var(--bg3);color:var(--fg2);font-size:12px;font-weight:700}
.sidebar-scroll-btn:hover{background:var(--bg);color:var(--fg)}
.brand{display:flex;align-items:center;gap:8px;font-family:var(--font-display);font-weight:700;font-size:20px;color:var(--fg);padding:4px 10px}
.brand-mark{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px}
.sidebar-collapse-btn{margin-left:auto;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:1px solid var(--bg4);border-radius:7px;background:var(--bg3);color:var(--fg2);font-size:12px;cursor:pointer}
.sidebar-collapse-btn:hover{background:var(--bg);color:var(--fg)}
.workspace-menu{display:flex;flex-direction:column;gap:6px}
.workspace-menu button,.workspace-menu a{display:flex;align-items:center;justify-content:flex-start;gap:10px;width:100%;padding:10px 12px;border-radius:10px;color:var(--fg2);font-size:13px;font-weight:600;border:1px solid transparent;background:transparent;transition:all .16s ease;min-height:38px}
.workspace-menu button:hover,.workspace-menu a:hover{background:var(--bg3);border-color:var(--bg4);color:var(--fg)}
.workspace-menu .active{background:var(--accent-dim);color:var(--accent2);border-color:color-mix(in oklab,var(--accent) 45%, var(--bg4));box-shadow:inset 0 0 0 1px color-mix(in oklab,var(--accent) 18%, transparent)}
.workspace-menu button:focus-visible,.workspace-menu a:focus-visible,.admin-subtab:focus-visible,.admin-group-btn:focus-visible,.workspace-history-toggle:focus-visible{outline:2px solid color-mix(in oklab,var(--accent) 78%, white);outline-offset:2px}
.nav-label{flex:1;text-align:left;letter-spacing:.01em;line-height:1.25}
.side-icon{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;color:var(--fg3);flex:0 0 16px}
.side-icon svg{width:16px;height:16px;display:block}
.workspace-menu button:hover .side-icon,.workspace-menu a:hover .side-icon{color:var(--fg2)}
.workspace-menu .active .side-icon{color:var(--accent2)}
.admin-nav-tree{display:flex;flex-direction:column;gap:6px}
.admin-parent{justify-content:space-between;width:100%}
.admin-parent .nav-label{margin-right:10px}
.admin-caret{margin-left:auto;font-size:11px;opacity:.68;transition:transform .16s ease}
.admin-caret.open{transform:rotate(180deg)}
.admin-nav-sub{margin-top:-2px;margin-left:6px;display:flex;flex-direction:column;gap:6px;padding-left:16px;border-left:1px solid color-mix(in oklab,var(--fg3) 24%, transparent)}
.admin-group-btn{display:flex;align-items:center;justify-content:space-between;width:100%;font-size:11px;font-weight:700;letter-spacing:.045em;text-transform:uppercase;color:var(--fg3);background:var(--bg3);border:1px solid var(--bg4);border-radius:9px;padding:7px 9px;min-height:34px}
.admin-group-btn:hover{background:var(--bg);color:var(--fg2)}
.admin-group-list{display:flex;flex-direction:column;gap:4px;padding-left:20px}
.admin-subtab{display:flex;align-items:center;justify-content:flex-start;text-align:left;width:100%;font-size:12px;font-weight:600;color:var(--fg2);background:transparent;border:1px solid transparent;border-radius:8px;padding:7px 10px;min-height:34px}
.admin-subtab::before{content:'';width:4px;height:4px;border-radius:50%;background:color-mix(in oklab,var(--fg3) 70%, transparent);margin-right:8px;flex:0 0 auto}
.admin-subtab:hover{background:var(--bg3);color:var(--fg)}
.admin-subtab:hover::before{background:var(--fg2)}
.admin-subtab.active{background:var(--accent-dim);color:var(--accent2);border-color:color-mix(in oklab,var(--accent) 32%, var(--bg4))}
.admin-subtab.active::before{background:var(--accent2)}
.workspace-history{display:flex;flex-direction:column;gap:8px;min-height:0}
.workspace-history-toggle{display:flex;align-items:center;justify-content:space-between;width:100%;background:transparent;border:1px solid transparent;border-radius:10px;padding:6px 8px;color:var(--fg3);font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.workspace-history-toggle:hover{background:var(--bg3);border-color:var(--bg4);color:var(--fg2)}
.workspace-history-label{padding:0 2px;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:inherit}
.workspace-history-empty{padding:0 10px;font-size:12px;color:var(--fg3)}
.chat-item{align-items:flex-start;gap:10px}
.chat-item-copy{min-width:0;flex:1;display:flex;flex-direction:column;gap:3px}
.chat-item-title{font-size:13px;font-weight:700;color:inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chat-item-meta{font-size:11px;color:var(--fg3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chat-item.active .chat-item-meta{color:rgba(255,255,255,.72)}
.workspace-spacer{display:none}
@media (prefers-reduced-motion: reduce){.workspace-menu button,.workspace-menu a,.admin-caret{transition:none}}

.workspace-nav.collapsed .word,
.workspace-nav.collapsed .nav-label,
.workspace-nav.collapsed .workspace-history,
.workspace-nav.collapsed .admin-caret,
.workspace-nav.collapsed .admin-nav-sub{display:none}
.workspace-nav.collapsed .workspace-menu{gap:8px}
.workspace-nav.collapsed .workspace-menu button,
.workspace-nav.collapsed .workspace-menu a{justify-content:center;padding:10px 0}
.workspace-nav.collapsed .side-icon{width:18px;height:18px;flex:0 0 18px}
.workspace-nav.collapsed .sidebar-collapse-btn{margin-left:0}
.workspace-home{flex:1;display:flex;flex-direction:column;padding:14px 22px 18px;gap:14px;overflow:hidden;min-height:0}
.workspace-top-card{background:var(--bg2);border:1px solid var(--bg4);border-radius:18px;padding:14px 16px;display:grid;grid-template-columns:auto auto 1fr auto;gap:14px;align-items:center;box-shadow:var(--shadow-soft)}
.user-chip{display:flex;align-items:center;gap:10px;min-width:220px}
.user-chip img{width:36px;height:36px;border-radius:50%;object-fit:cover}
.user-chip .name{font-weight:700;font-size:13px;color:var(--fg)}
.user-chip .role{font-size:11px;color:var(--fg3)}
.today-badge{display:inline-flex;align-items:center;gap:6px;background:var(--bg3);border:1px solid var(--bg4);padding:8px 12px;border-radius:10px;font-size:12px;color:var(--fg2);font-weight:700}
.semantic-search{position:relative}
.semantic-search input{width:100%;padding:10px 14px;border-radius:999px;border:1px solid var(--bg4);background:var(--bg3);font-size:13px;color:var(--fg)}
.semantic-search input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(37,99,235,.1)}
.search-dd{position:absolute;left:0;right:0;top:46px;z-index:60;background:var(--bg2);border:1px solid var(--bg4);border-radius:12px;box-shadow:var(--shadow-hover);max-height:280px;overflow-y:auto}
.search-item{padding:10px 12px;border-bottom:1px solid var(--bg4);cursor:pointer}
.search-item:last-child{border-bottom:none}
.search-item:hover{background:var(--bg3)}
.search-item .ttl{font-size:13px;font-weight:700;color:var(--fg)}
.search-item .sub{font-size:11px;color:var(--fg3);margin-top:2px}
.top-actions{display:flex;align-items:center;gap:8px}
.icon-circle{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--bg3);border:1px solid var(--bg4);color:var(--fg2);font-size:14px;position:relative}
.ui-icon{display:inline-flex;align-items:center;justify-content:center;width:14px;color:var(--fg3);opacity:.85;font-size:13px;line-height:1}
.notif-dot{position:absolute;top:7px;right:9px;width:8px;height:8px;border-radius:50%;background:var(--danger)}
.profile-avatar{width:38px;height:38px;border-radius:50%;background:var(--solid);color:var(--solid-contrast);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;cursor:pointer;border:2px solid transparent;transition:all .18s ease;overflow:hidden}
.profile-avatar img{width:100%;height:100%;object-fit:cover;border-radius:50%}
.profile-avatar:hover{border-color:var(--fg3)}
.workspace-body{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:14px;flex:1;overflow:hidden;align-items:stretch;min-height:0}
.center-card{background:var(--bg2);border:1px solid var(--bg4);border-radius:20px;display:flex;flex-direction:column;min-height:0;overflow:hidden;box-shadow:var(--shadow-soft);height:100%;align-self:stretch}
.center-card-hdr{padding:14px 16px;border-bottom:1px solid var(--bg4);display:flex;align-items:center;justify-content:space-between;gap:12px}
.agent-strip{display:flex;align-items:center;gap:8px}
.agent-strip .lead{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;color:var(--fg)}
.agent-strip .lead img{width:34px;height:34px;border-radius:50%;object-fit:cover;border:1px solid var(--bg4)}
.worker-avatars{display:flex;align-items:center}
.worker-avatars img{width:24px;height:24px;border-radius:50%;object-fit:cover;border:2px solid var(--bg2);margin-left:-6px;background:var(--bg3)}
.center-card-hdr .title{font-size:13px;color:var(--fg2);font-weight:600}
.right-rail{display:flex;flex-direction:column;gap:10px;min-height:0;height:100%;align-self:stretch}
.side-card{background:var(--bg2);border:1px solid var(--bg4);border-radius:18px;padding:14px;box-shadow:var(--shadow-soft)}
.side-card h3{font-size:14px;font-weight:800;font-family:var(--font-display);margin-bottom:8px}
.schedule-card{padding:0;overflow:hidden;display:flex;flex-direction:column;flex:1;min-height:0}
.schedule-head{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:6px;padding:8px 8px 7px;border-bottom:1px solid var(--bg4)}
.schedule-head .ttl{font-size:15px;font-family:var(--font-display);font-weight:700;display:flex;align-items:center;gap:6px}
.see-all{font-size:9.5px;font-weight:700;color:var(--fg2);background:var(--bg3);border:1px solid var(--bg4);padding:5px 7px;border-radius:9px;display:inline-flex;align-items:center;gap:4px;white-space:nowrap;min-width:max-content}
.month-nav{display:flex;align-items:center;justify-content:center;gap:4px;min-width:0}
.month-pill{flex:1;text-align:center;font-size:11px;font-weight:800;color:var(--fg);background:var(--bg3);border:1px solid var(--bg4);border-radius:8px;padding:5px 0;min-width:70px}
.icon-btn-sm{width:20px;height:20px;border-radius:7px;background:var(--bg3);border:1px solid var(--bg4);display:flex;align-items:center;justify-content:center;color:var(--fg2);font-size:11px}
.day-strip{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;padding:8px 12px 8px}
.day-chip{border:1px solid var(--bg4);background:var(--bg2);border-radius:10px;padding:5px 3px;text-align:center;cursor:pointer;transition:all .15s ease}
.day-chip:hover{border-color:var(--fg3)}
.day-chip .dw{font-size:9px;color:var(--fg3);font-weight:700}
.day-chip .dn{font-size:12px;line-height:1.1;font-weight:800;color:var(--fg);margin-top:2px}
.day-chip.active{background:#6B4CE6;border-color:#6B4CE6}
.day-chip.active .dw,.day-chip.active .dn{color:#fff}
.month-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:5px;padding:8px 10px}
.month-grid .mh{font-size:10px;color:var(--fg3);text-align:center;font-weight:700;padding:2px 0}
.month-grid .md{border:1px solid var(--bg4);background:var(--bg2);border-radius:8px;min-height:24px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--fg2);cursor:pointer;transition:all .15s ease}
.month-grid .md:hover{border-color:var(--fg3)}
.month-grid .md.empty{visibility:hidden}
.month-grid .md.active{background:#6B4CE6;color:#fff;border-color:#6B4CE6}
.month-grid .md.has{background:var(--accent-dim);color:var(--accent);border-color:rgba(37,99,235,.2)}
.month-grid .md.has.active{background:#6B4CE6;color:#fff;border-color:#6B4CE6}
.schedule-search{padding:0 12px 8px}
.schedule-search .search-row{display:flex;align-items:center;gap:8px;border:1px solid var(--bg4);background:var(--bg3);border-radius:11px;padding:8px 10px;font-size:12px;color:var(--fg3)}
.schedule-tabs{display:grid;grid-template-columns:repeat(3,1fr);border-top:1px solid var(--bg4);border-bottom:1px solid var(--bg4)}
.schedule-tab{padding:9px 8px;text-align:center;font-size:11px;color:var(--fg2);font-weight:700;position:relative;cursor:pointer}
.schedule-tab.active{color:#6B4CE6}
.schedule-tab.active::after{content:'';position:absolute;left:14px;right:14px;bottom:0;height:2px;background:#6B4CE6;border-radius:2px}
.schedule-meetings{padding:9px 12px;display:flex;flex-direction:column;gap:8px;overflow-y:auto;min-height:120px}
.meet-card{border-radius:14px;padding:12px 12px 10px;border:1px solid transparent}
.meet-card.peach{background:#F6E2D2;border-color:#ECC8AA}
.meet-card.blue{background:#DDE6FB;border-color:#C5D6FA}
.meet-title{font-size:13px;font-weight:800;color:#3f2b1c}
.meet-card.blue .meet-title{color:#1f3463}
.meet-time{font-size:12px;color:rgba(39,39,39,.62);margin-top:4px}
.meet-row{display:flex;align-items:center;justify-content:space-between;margin-top:8px}
.mini-avatars{display:flex;align-items:center}
.mini-avatars img{width:18px;height:18px;border-radius:50%;object-fit:cover;border:1.5px solid rgba(255,255,255,.85);margin-left:-6px}
.mini-avatars img:first-child{margin-left:0}
.mini-more{font-size:11px;color:rgba(39,39,39,.62);margin-left:6px;font-weight:700}
.tag{font-size:10px;font-weight:800;letter-spacing:.2px;color:#A35B1E;border:1px solid #C97E3F;background:rgba(255,255,255,.55);padding:2px 8px;border-radius:999px}
.action-list{display:flex;flex-direction:column;gap:8px;max-height:240px;overflow-y:auto}
.actions-card{margin-top:auto;display:flex;flex-direction:column;min-height:180px;max-height:200px}
.actions-card h3{margin-bottom:10px}
.action-item{padding:9px 10px;border-radius:10px;border:1px solid var(--bg4);background:var(--bg3)}
.action-item.selectable{cursor:pointer;transition:all .18s ease}
.action-item.selectable:hover{background:var(--bg2);border-color:var(--fg3)}
.action-item.active{border-color:rgba(37,99,235,.3);background:var(--accent-dim)}
.action-item .at{font-size:12px;font-weight:700;color:var(--fg)}
.action-item .as{font-size:11px;color:var(--fg3);margin-top:2px}
.notif-list{max-height:280px;overflow-y:auto}
.notif-item{padding:10px 0;border-bottom:1px solid var(--bg4)}
.notif-item:last-child{border-bottom:none}
.notif-item .nt{font-size:13px;color:var(--fg);font-weight:700}
.notif-item .ns{font-size:11px;color:var(--fg3);margin-top:2px}

/* ── Chat view ──────────────────────────────── */
.chat-view{flex:1;display:flex;flex-direction:column;overflow:hidden}
.messages{flex:1;overflow-y:auto;padding:18px 20px;display:flex;flex-direction:column;gap:20px}
.msg{max-width:620px;width:100%;margin:0 auto;display:flex;gap:12px;align-items:flex-start}
.msg.user{flex-direction:row-reverse}
.msg .avatar{width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;flex-shrink:0;overflow:hidden}
.msg .avatar img{width:100%;height:100%;object-fit:cover;border-radius:50%}
.msg.user .avatar{background:var(--solid);color:var(--solid-contrast)}
.msg.assistant .avatar{background:var(--bg3);color:var(--fg2);border:1px solid var(--bg4)}
.msg .bubble{padding:14px 18px;border-radius:var(--radius-lg);font-size:14px;line-height:1.6;white-space:pre-wrap;word-break:break-word}
.msg.user .bubble{background:var(--solid);color:var(--solid-contrast);border-bottom-right-radius:4px}
.msg.assistant .bubble{background:var(--bg2);color:var(--fg);border:1px solid var(--bg4);border-bottom-left-radius:4px;box-shadow:var(--shadow-soft);white-space:normal}
.msg .meta{font-size:11px;color:var(--fg3);margin-top:6px}
.msg .meta span{margin-right:10px}
.msg-body{position:relative}
/* Differentiated failure UI (Round 2). Error = clear-but-calm amber card with a matching recovery.
   Refusal = neutral "declined" note (deliberately NOT styled like a system error). */
.msg-error{display:flex;align-items:flex-start;gap:10px;margin-top:4px;padding:11px 14px;border-radius:12px;background:var(--danger-zone-bg);border:1px solid var(--danger-zone-border);color:var(--danger-zone-fg);font-size:13.5px;line-height:1.5}
.msg-error-icon{flex:none;line-height:1.4}
.msg-error-text{flex:1;min-width:0}
.msg-error-actions{display:flex;gap:8px;margin-top:9px}
.msg-retry{font-size:13px;font-weight:600;color:var(--danger-zone-fg);background:var(--surface);border:1px solid var(--danger-zone-border);border-radius:8px;padding:7px 14px;cursor:pointer;min-height:32px}
.msg-retry:hover{background:var(--danger-zone-bg)}
.msg-refusal{display:flex;align-items:flex-start;gap:10px;margin-top:4px;padding:11px 14px;border-radius:12px;background:var(--bg3);border:1px solid var(--bg4);color:var(--fg2);font-size:13.5px;line-height:1.5}
.msg-refusal-icon{flex:none;color:var(--fg3);line-height:1.4}
.msg-refusal-text{flex:1;min-width:0}
.resp-corner{position:absolute;top:-8px;right:-8px;display:flex;gap:6px;z-index:3}
.resp-ind{width:22px;height:22px;border-radius:999px;border:1px solid var(--bg4);background:var(--bg2);color:var(--fg3);display:flex;align-items:center;justify-content:center;font-size:11px;box-shadow:var(--shadow-soft);cursor:help}
.resp-ind.ok{color:var(--success);border-color:rgba(22,163,74,.25)}
.resp-ind.warn{color:var(--warn);border-color:rgba(217,119,6,.3)}
.resp-ind.deny{color:var(--danger);border-color:rgba(220,38,38,.28)}

/* ── Rich text (assistant bubble) ───────── */
.msg.assistant .bubble h1,.msg.assistant .bubble h2,.msg.assistant .bubble h3,.msg.assistant .bubble h4{margin:16px 0 8px;font-weight:700;color:var(--fg);line-height:1.3}
.msg.assistant .bubble h1{font-size:20px}
.msg.assistant .bubble h2{font-size:17px}
.msg.assistant .bubble h3{font-size:15px}
.msg.assistant .bubble h4{font-size:14px}
.msg.assistant .bubble p{margin:0 0 10px;line-height:1.65}
.msg.assistant .bubble ul,.msg.assistant .bubble ol{margin:0 0 10px 20px}
.msg.assistant .bubble li{margin-bottom:4px}
.msg.assistant .bubble code{font-family:var(--mono);font-size:12.5px;background:var(--bg3);border:1px solid var(--bg4);padding:2px 6px;border-radius:6px}
.msg.assistant .bubble pre{background:var(--bg3);border:1px solid var(--bg4);border-radius:var(--radius);padding:14px 16px;margin:10px 0;overflow-x:auto;position:relative}
.msg.assistant .bubble pre code{background:none;border:none;padding:0;font-size:12px;line-height:1.5}
.msg.assistant .bubble blockquote{border-left:3px solid var(--bg4);padding:6px 14px;margin:10px 0;color:var(--fg2);background:var(--bg3);border-radius:0 var(--radius) var(--radius) 0}
.msg.assistant .bubble table{width:100%;border-collapse:collapse;margin:10px 0;font-size:13px}
.msg.assistant .bubble th,.msg.assistant .bubble td{padding:8px 12px;text-align:left;border:1px solid var(--bg4)}
.msg.assistant .bubble th{background:var(--bg3);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.3px;color:var(--fg2)}
.msg.assistant .bubble hr{border:none;height:1px;background:var(--bg4);margin:16px 0}
.msg.assistant .bubble a{color:var(--accent);text-decoration:underline}
.msg.assistant .bubble strong{font-weight:600}
.msg.assistant .bubble em{font-style:italic}
.msg.assistant .bubble .response-rich{display:flex;flex-direction:column;gap:12px}
.msg.assistant .bubble .response-rich-embedded{margin-top:12px}
.msg.assistant .bubble .response-note{margin:0;font-size:13px;line-height:1.6;color:var(--fg2)}
.msg.assistant .bubble .response-table-wrap{overflow:auto;border:1px solid var(--bg4);border-radius:10px;background:var(--bg2)}
.msg.assistant .bubble .response-table{width:100%;border-collapse:separate;border-spacing:0;font-size:12px}
.msg.assistant .bubble .response-table th,.msg.assistant .bubble .response-table td{padding:8px 10px;border-right:1px solid var(--bg4);border-bottom:1px solid var(--bg4);text-align:left;vertical-align:top}
.msg.assistant .bubble .response-table th:last-child,.msg.assistant .bubble .response-table td:last-child{border-right:0}
.msg.assistant .bubble .response-table tr:last-child td{border-bottom:0}
.msg.assistant .bubble .response-table th{background:var(--bg3);font-weight:700;color:var(--fg);position:sticky;top:0;z-index:1}
.msg.assistant .bubble .response-table td{font-family:var(--mono);font-size:11.5px;color:var(--fg2);white-space:pre-wrap;word-break:break-word;max-width:340px}
.msg.assistant .bubble .response-chart{border:1px solid var(--bg4);border-radius:10px;background:var(--bg2);padding:10px}
.msg.assistant .bubble .response-chart-title{font-size:12px;font-weight:700;color:var(--fg);margin-bottom:8px}
.msg.assistant .bubble .response-bars{display:flex;flex-direction:column;gap:6px}
.msg.assistant .bubble .response-bar-row{display:grid;grid-template-columns:minmax(80px,140px) 1fr minmax(56px,90px);align-items:center;gap:8px}
.msg.assistant .bubble .response-bar-label{font-size:11px;color:var(--fg2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.msg.assistant .bubble .response-bar-track{height:8px;border-radius:999px;background:var(--bg3);overflow:hidden}
.msg.assistant .bubble .response-bar-fill{height:100%;background:linear-gradient(90deg,var(--accent),#2AB090)}
.msg.assistant .bubble .response-bar-value{font-size:11px;color:var(--fg3);text-align:right;font-family:var(--mono)}
.msg.assistant .bubble .response-line svg{width:100%;height:180px;display:block}
.msg.assistant .bubble .response-line-axis{stroke:var(--bg4);stroke-width:1}
.msg.assistant .bubble .response-line-path{fill:none;stroke:var(--accent);stroke-width:2}
.msg.assistant .bubble .response-line-dot{fill:var(--accent)}
.msg.assistant .bubble .response-line-labels{display:flex;justify-content:space-between;gap:6px;margin-top:6px}
.msg.assistant .bubble .response-line-labels span{font-size:10px;color:var(--fg3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:80px}
.msg.assistant .bubble .detail-block{border:1px solid var(--bg4);border-radius:10px;background:var(--bg2);overflow:hidden}
.msg.assistant .bubble .detail-block-hdr{display:flex;align-items:center;justify-content:space-between;padding:6px 8px;border-bottom:1px solid var(--bg4);background:var(--bg3)}
.msg.assistant .bubble .detail-lang{font-size:10px;font-weight:700;letter-spacing:.3px;color:var(--fg3);text-transform:uppercase}
.msg.assistant .bubble .detail-kind{font-size:10px;color:var(--fg3)}
.msg.assistant .bubble .detail-block-actions{display:flex;align-items:center;gap:6px}
.msg.assistant .bubble .detail-copy-btn{font-size:10px;line-height:1;border:1px solid var(--bg4);background:var(--bg2);color:var(--fg2);border-radius:999px;padding:4px 8px;cursor:pointer}
.msg.assistant .bubble .detail-copy-btn:hover{border-color:var(--fg3);color:var(--fg)}
.msg.assistant .bubble .detail-copy-btn.copied{border-color:rgba(22,163,74,.25);background:rgba(22,163,74,.1);color:var(--success)}
.msg.assistant .bubble .detail-code{margin:0;padding:8px 10px;font-size:11px;line-height:1.45;color:var(--fg2);font-family:var(--mono);white-space:pre;overflow:auto;max-height:260px}

/* ── Response toolbar ───────────────────── */
.response-toolbar{display:flex;gap:4px;margin-top:8px;opacity:0;transition:opacity .18s ease}
.msg.assistant:hover .response-toolbar{opacity:1}
/* Keep the toolbar visible while a feedback reason panel is open, and once an answer has been rated. */
.response-toolbar:has(.fb-panel),.response-toolbar:has(.fb-on),.response-toolbar:focus-within{opacity:1}
.tb-btn{display:inline-flex;align-items:center;gap:5px;padding:5px 12px;border-radius:999px;font-size:11px;font-weight:500;color:var(--fg3);background:var(--bg3);border:1px solid var(--bg4);cursor:pointer;transition:all .18s ease;font-family:var(--font)}
.tb-btn:hover{color:var(--fg);background:var(--bg);border-color:var(--fg3)}
.tb-btn svg{width:13px;height:13px;stroke:currentColor;fill:none;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.tb-btn.copied{color:var(--success);border-color:var(--success);background:rgba(22,163,74,.06)}
.copy-toast{position:fixed;bottom:32px;left:50%;transform:translateX(-50%);background:var(--solid);color:var(--solid-contrast);padding:8px 20px;border-radius:999px;font-size:13px;font-weight:500;z-index:10001;opacity:0;transition:opacity .2s;pointer-events:none}
.copy-toast.show{opacity:1}
/* m137 — answer feedback (thumbs + tiered reasons) + AI-generated disclosure. Neutrals = you; emerald = AI. */
.fb-wrap{display:inline-flex;align-items:center;gap:4px;position:relative;flex-wrap:wrap}
.fb-btn{padding:5px 9px;line-height:1}
.fb-btn.fb-on{color:var(--accent2);background:var(--accent-dim);border-color:color-mix(in oklab,var(--accent) 40%, var(--bg4))}
.fb-thanks{font-size:11px;color:var(--fg3);margin-left:2px}
.fb-panel{position:absolute;top:calc(100% + 6px);left:0;z-index:60;width:290px;max-width:80vw;background:var(--bg);border:1px solid var(--bg4);border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.14);padding:12px;display:flex;flex-direction:column;gap:8px}
.fb-panel-title{font-size:12px;font-weight:600;color:var(--fg)}
.fb-chips{display:flex;flex-wrap:wrap;gap:6px}
.fb-chip{font-size:11px;padding:5px 10px;border-radius:999px;color:var(--fg2);background:var(--bg3);border:1px solid var(--bg4);cursor:pointer;font-family:var(--font);transition:all .15s ease}
.fb-chip:hover{border-color:var(--fg3)}
.fb-chip.on{color:var(--accent2);background:var(--accent-dim);border-color:color-mix(in oklab,var(--accent) 45%, var(--bg4))}
.fb-comment{width:100%;box-sizing:border-box;font-family:var(--font);font-size:12px;color:var(--fg);background:var(--bg2);border:1px solid var(--bg4);border-radius:8px;padding:7px 9px;resize:vertical}
.fb-comment:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in oklab,var(--accent) 14%, transparent)}
.fb-panel-actions{display:flex;justify-content:flex-end;gap:8px}
.fb-cancel,.fb-send{font-size:12px;font-weight:500;padding:6px 12px;border-radius:8px;cursor:pointer;font-family:var(--font);border:1px solid var(--bg4)}
.fb-cancel{color:var(--fg3);background:var(--bg3)}
.fb-send{color:var(--solid-contrast);background:var(--accent);border-color:var(--accent)}
.fb-send:hover{background:var(--accent2)}
.ai-disclosure{display:flex;align-items:center;gap:6px;margin-top:8px;font-size:11px;color:var(--fg3)}
.ai-disclosure-dot{color:var(--accent)}
/* m138 — answer citations in chat: the composer toggle + inline [n] chips + verified source cards. */
.composer-tools{display:flex;gap:6px;align-items:center;margin-top:6px}
.cite-toggle{display:inline-flex;align-items:center;gap:5px;padding:5px 11px;border-radius:999px;font-size:11px;font-weight:500;color:var(--fg3);background:var(--bg3);border:1px solid var(--bg4);cursor:pointer;font-family:var(--font);transition:all .18s ease}
.cite-toggle:hover{color:var(--fg);border-color:var(--fg3)}
.cite-toggle.on{color:var(--accent2);background:var(--accent-dim);border-color:color-mix(in oklab,var(--accent) 45%, var(--bg4))}
.chat-cite-answer{font-size:14px;line-height:1.7;color:var(--fg1);white-space:pre-wrap}
.chat-cite-chip{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;margin:0 1px;padding:0 4px;font-size:10px;font-weight:700;color:#0B7A57;background:#E8F5EE;border:1px solid #BfE6D4;border-radius:999px;cursor:pointer;vertical-align:super;line-height:1;font-family:var(--font)}
.chat-cite-chip:hover{background:#0B7A57;color:#fff}
.chat-cite-chip.unmatched{color:var(--fg2);background:var(--bg4);border-color:var(--bg4);cursor:default}
.chat-cite-label{font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--fg2);margin:12px 0 6px}
.chat-cite-card{display:flex;align-items:baseline;gap:6px;border:1px solid var(--bg4);border-left:3px solid #0B7A57;border-radius:6px;padding:6px 8px;margin-bottom:5px}
.chat-cite-card.openable{cursor:pointer}
.chat-cite-card.openable:hover{border-color:#0B7A57;background:#F4FBF7}
.chat-cite-n{font-weight:700;color:var(--accent);font-size:11px}
.chat-cite-quote{font-size:12px;color:var(--fg1);font-style:italic;flex:1}
.chat-cite-src{font-size:11px;color:var(--fg2);white-space:nowrap}
.chat-cite-ungrounded{font-size:12px;color:var(--fg2);border:1px dashed var(--bg4);border-radius:6px;padding:7px 9px;margin-top:8px}
/* m139 — regenerate + version pager on an assistant answer. */
.ver-wrap{display:inline-flex;align-items:center;gap:4px}
.ver-nav{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border-radius:6px;font-size:14px;line-height:1;color:var(--fg3);background:var(--bg3);border:1px solid var(--bg4);cursor:pointer;font-family:var(--font)}
.ver-nav:hover:not([disabled]){color:var(--fg);border-color:var(--fg3)}
.ver-nav[disabled]{opacity:.4;cursor:default}
.ver-count{font-size:11px;font-weight:500;color:var(--fg2);min-width:26px;text-align:center}
.ver-regen.busy{opacity:.7;cursor:default}
/* m140 / H19 — visually-hidden live region for accessible streaming announcements (screen-reader only). */
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
/* m140 / reduced motion — workspace default or the reader's OS setting damps stream/typing animations. */
html[data-reduced-motion] *,html[data-reduced-motion] *::before,html[data-reduced-motion] *::after{animation-duration:0.001ms !important;animation-iteration-count:1 !important;transition-duration:0.001ms !important;scroll-behavior:auto !important}
/* m141 / H13 — a clear, consistent focus ring on EVERY interactive control when reached by keyboard, so a
   keyboard/screen-reader user can always see where they are (incl. the div-as-button controls fixed in R4). */
a:focus-visible,button:focus-visible,[role="button"]:focus-visible,[tabindex]:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid color-mix(in oklab,var(--accent) 78%, white);outline-offset:2px;border-radius:6px}
/* "Always show focus outlines" workspace default — force the ring even for mouse users who :focus a control. */
html[data-force-focus-ring] a:focus,html[data-force-focus-ring] button:focus,html[data-force-focus-ring] [role="button"]:focus,html[data-force-focus-ring] [tabindex]:focus,html[data-force-focus-ring] input:focus,html[data-force-focus-ring] textarea:focus,html[data-force-focus-ring] select:focus{outline:2px solid color-mix(in oklab,var(--accent) 78%, white) !important;outline-offset:2px}
/* m144 / Round 8 — loading skeletons (placeholder shapes while a slow view loads → no blank flash / CLS). */
.skel{display:flex;flex-direction:column;gap:10px;padding:8px 2px}
.skel-row{display:flex;align-items:center;gap:10px}
.skel-dot{width:26px;height:26px;border-radius:8px;flex-shrink:0;background:var(--bg3)}
.skel-lines{flex:1;display:flex;flex-direction:column;gap:6px;min-width:0}
.skel-line{height:10px;border-radius:6px;background:linear-gradient(90deg,var(--bg3) 25%,var(--bg4) 37%,var(--bg3) 63%);background-size:400% 100%;animation:skel-shimmer 1.4s ease infinite}
.skel-line.skel-big{height:34px;border-radius:10px;margin:8px 0}
.skel-line.w30{width:30%}.skel-line.w40{width:40%}.skel-line.w50{width:50%}.skel-line.w60{width:60%}.skel-line.w70{width:70%}.skel-line.w80{width:80%}
.skel-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;padding:8px 2px}
.skel-card{border:1px solid var(--bg4);border-radius:12px;padding:16px;background:var(--bg2)}
.skel-fallback{padding:14px;color:var(--fg3);font-size:13px}
@keyframes skel-shimmer{0%{background-position:100% 0}100%{background-position:0 0}}
/* m142 / Round 5 — accessible confirm/notice dialog (replaces native alert()/confirm()). */
.gw-dialog-overlay{position:fixed;inset:0;z-index:10050;background:rgba(20,32,27,.34);display:flex;align-items:center;justify-content:center;padding:20px}
.gw-dialog{background:var(--bg);border:1px solid var(--bg4);border-radius:16px;box-shadow:0 18px 50px rgba(0,0,0,.22);width:440px;max-width:92vw;padding:22px 22px 18px}
.gw-dialog-title{font-family:var(--font);font-weight:700;font-size:16px;color:var(--fg);margin-bottom:8px}
.gw-dialog-msg{font-size:14px;line-height:1.6;color:var(--fg2);margin-bottom:18px;white-space:pre-wrap}
.gw-dialog-input{display:block;width:100%;box-sizing:border-box;font-family:var(--font);font-size:14px;color:var(--fg);background:var(--bg2);border:1px solid var(--bg4);border-radius:10px;padding:10px 12px;margin-bottom:18px;resize:vertical}
.gw-dialog-input::placeholder{color:var(--fg3)}
.gw-dialog-input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--mint-wash)}
.gw-dialog-btn:disabled{opacity:.5;cursor:not-allowed}
.gw-dialog-actions{display:flex;justify-content:flex-end;gap:10px}
.gw-dialog-btn{font-size:14px;font-weight:600;padding:9px 16px;border-radius:10px;cursor:pointer;font-family:var(--font);border:1px solid var(--bg4);background:var(--bg3);color:var(--fg2)}
.gw-dialog-btn:hover{border-color:var(--fg3);color:var(--fg)}
.gw-dialog-btn.primary{background:var(--solid);color:var(--solid-contrast);border-color:var(--solid)}
.gw-dialog-btn.primary:hover{background:var(--solid-hover)}
.gw-dialog-btn.danger{background:var(--danger);color:#fff;border-color:var(--danger)}
.gw-dialog-btn.danger:hover{background:var(--coral)}
/* m142 / H15 — recoverable data-load error banner (replaces silent catch). */
.load-error-host{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:10040;display:none;flex-direction:column;gap:8px;width:min(560px,92vw)}
.load-error{display:flex;align-items:center;gap:10px;background:#FEF3F2;border:1px solid #FDA29B;border-radius:12px;padding:10px 12px;box-shadow:0 8px 24px rgba(0,0,0,.12)}
[data-theme="dark"] .load-error{background:#3A1B1B;border-color:#7A3A34}
.load-error-icon{color:var(--danger)}
.load-error-text{flex:1;font-size:13px;color:var(--fg1)}
.load-error-retry{font-size:12px;font-weight:600;padding:5px 12px;border-radius:8px;border:1px solid var(--danger);background:transparent;color:var(--danger);cursor:pointer;font-family:var(--font)}
.load-error-retry:hover{background:var(--danger);color:#fff}
.load-error-x{border:none;background:none;font-size:18px;line-height:1;color:var(--fg3);cursor:pointer}
.empty-chat{flex:1;display:flex;align-items:center;justify-content:center;color:var(--fg3);font-size:15px;flex-direction:column;gap:8px}
.empty-chat .logo{font-size:48px;margin-bottom:8px}
/* m146 — suggested / starter prompt cards on the empty chat */
.suggested-prompts{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px;width:100%;max-width:640px;margin-top:18px}
.prompt-card{display:flex;align-items:flex-start;gap:10px;text-align:left;padding:12px 14px;border:1px solid var(--bg4);border-radius:var(--radius);background:var(--bg2);color:var(--fg);cursor:pointer;font:inherit;transition:border-color .15s ease,background .15s ease,transform .06s ease}
.prompt-card:hover{border-color:var(--accent);background:var(--bg1)}
.prompt-card:active{transform:translateY(1px)}
.prompt-card:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.prompt-card.personalized{border-color:var(--mint-border);background:var(--mint-wash)}
.prompt-card.personalized:hover{border-color:var(--accent);background:var(--mint)}
.prompt-card-icon{font-size:18px;line-height:1.2;flex:0 0 auto}
.prompt-card-body{display:flex;flex-direction:column;gap:3px;min-width:0}
.prompt-card-title{font-size:13.5px;font-weight:600;color:var(--fg);line-height:1.3}
.prompt-card-tag{font-size:10.5px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;color:var(--mint-deep);align-self:flex-start}
@media (prefers-reduced-motion: reduce){.prompt-card{transition:none}}

/* ── Input bar ──────────────────────────────── */
.input-bar{padding:20px 32px;border-top:1px solid var(--bg4);display:flex;gap:12px;align-items:flex-end;background:var(--bg2)}
.input-bar textarea{flex:1;padding:14px 16px;border-radius:var(--radius-lg);border:1px solid var(--bg4);background:var(--bg2);color:var(--fg);font-size:14px;resize:none;min-height:48px;max-height:160px;line-height:1.5;font-family:var(--font);transition:border-color .18s ease}
.input-bar textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(37,99,235,.1)}
/* H18 — fixed footprint (height + min-width) so Send↔Stop swap and streaming growth cause ZERO layout shift. */
.input-bar .send-btn{padding:12px 24px;border-radius:999px;background:var(--solid);color:var(--solid-contrast);font-weight:600;font-size:14px;height:48px;min-width:104px;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:7px;transition:background .18s ease}
.input-bar .send-btn:hover{background:var(--solid-hover)}
.input-bar .send-btn:disabled{opacity:.4;cursor:not-allowed}
/* Stop-generating control (Round 3): same footprint as Send so the layout doesn't shift when it swaps. */
.input-bar .send-btn.stop-btn{background:var(--danger);color:#fff}
.input-bar .send-btn.stop-btn:hover{background:var(--coral)}
.input-bar .model-sel{padding:10px 12px;border-radius:var(--radius);border:1px solid var(--bg4);background:var(--bg2);color:var(--fg2);font-size:13px;height:48px}
.routing-badge{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:var(--radius);border:1px solid var(--bg4);background:var(--bg2);color:var(--fg2);font-family:var(--font);font-size:13px;font-weight:500;cursor:help;white-space:nowrap;box-sizing:border-box;line-height:1.4}
.routing-badge svg{width:12px;height:12px;opacity:.5;color:var(--fg3);flex-shrink:0}
.input-tools{display:flex;align-items:center;gap:8px}
.tool-btn{width:42px;height:42px;border-radius:12px;border:1px solid var(--bg4);background:var(--bg3);color:var(--fg2);font-size:16px;display:flex;align-items:center;justify-content:center;transition:all .18s ease}
.tool-btn:hover{background:var(--bg2);border-color:var(--fg3);color:var(--fg)}
.tool-btn.active{background:var(--accent-dim);border-color:var(--accent);color:var(--accent)}
.mic-btn{background:transparent;border-color:var(--bg4);color:var(--fg3);filter:grayscale(1)}
.mic-btn svg{display:block;opacity:.75}
.mic-btn:hover{background:transparent;border-color:var(--fg3);color:var(--fg2)}
.mic-btn:hover svg{opacity:1}
.mic-btn.active{background:transparent;border-color:var(--fg2);color:var(--fg);filter:none;animation:mic-pulse 1.4s ease-in-out infinite}
.mic-btn.active svg{opacity:1}
@keyframes mic-pulse{0%,100%{box-shadow:0 0 0 0 rgba(255,255,255,0)}50%{box-shadow:0 0 0 4px rgba(255,255,255,.08)}}
.voice-agent-btn{position:relative}
.voice-agent-btn.active{background:var(--accent-dim);border-color:var(--accent);color:var(--accent)}
.voice-agent-btn circle{display:none}
.voice-agent-btn.active circle{display:block}
/* ── Voice agent bar ─────────────────────────────── */
.voice-bar{background:var(--bg3);border:1px solid var(--accent);border-radius:var(--radius);padding:10px 14px;display:flex;flex-direction:column;gap:8px;margin-bottom:4px}
.voice-bar-top{display:flex;align-items:center;gap:8px}
.voice-status-indicator{width:8px;height:8px;border-radius:50%;flex-shrink:0;background:var(--fg3)}
.voice-status-indicator.voice-status-idle{background:var(--fg3)}
.voice-status-indicator.voice-status-listening{background:var(--success);animation:va-pulse 2s ease-in-out infinite}
.voice-status-indicator.voice-status-recording{background:var(--danger);animation:va-pulse 0.8s ease-in-out infinite}
.voice-status-indicator.voice-status-processing{background:var(--warn);animation:va-pulse 1.1s ease-in-out infinite}
.voice-status-indicator.voice-status-playing{background:var(--accent);animation:va-pulse 0.55s ease-in-out infinite}
.voice-status-indicator.voice-status-paused{background:var(--fg3)}
@keyframes va-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.7)}}
.voice-status-label{font-size:12px;font-weight:600;color:var(--fg2);flex:1}
.voice-pause-btn{display:flex;align-items:center;gap:4px;font-size:11px;font-weight:600;color:var(--fg3);padding:3px 10px;border-radius:6px;border:1px solid var(--bg4);background:var(--bg2);white-space:nowrap}
.voice-pause-btn:hover{color:var(--fg);border-color:var(--fg3)}
.voice-pause-btn.resume{color:var(--success);border-color:var(--success)}
.voice-pause-btn.resume:hover{background:rgba(22,163,74,.08)}
.voice-end-btn{font-size:13px;font-weight:600;color:var(--fg3);padding:3px 8px;border-radius:6px;border:1px solid var(--bg4);background:var(--bg2)}
.voice-end-btn:hover{color:var(--danger);border-color:var(--danger)}
.voice-settings-btn{font-size:14px;color:var(--fg3);padding:3px 7px;border-radius:6px;border:1px solid var(--bg4);background:var(--bg2);line-height:1}
.voice-settings-btn:hover{color:var(--fg);border-color:var(--fg3)}
.voice-settings-btn.active{color:var(--accent);border-color:var(--accent);background:var(--accent-dim)}
/* ── Voice settings panel ──────────────────────────── */
.va-settings-panel{display:flex;flex-direction:column;gap:6px;padding:10px 12px;background:var(--bg2);border-radius:8px;border:1px solid var(--bg4)}
.vs-row{display:flex;align-items:center;gap:8px;min-height:28px}
.vs-label{font-size:11px;font-weight:600;color:var(--fg3);width:72px;flex-shrink:0;text-transform:uppercase;letter-spacing:.04em}
.vs-select{font-size:12px;color:var(--fg);background:var(--bg3);border:1px solid var(--bg4);border-radius:6px;padding:2px 6px;flex:1}
.vs-select:focus{outline:none;border-color:var(--accent)}
.vs-mode-toggle{display:flex;gap:4px;flex:1}
.vs-mode-btn{font-size:11px;font-weight:600;color:var(--fg3);padding:3px 8px;border-radius:6px;border:1px solid var(--bg4);background:var(--bg3);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
.vs-mode-btn:hover{color:var(--fg);border-color:var(--fg3)}
.vs-mode-btn.active{color:var(--accent);border-color:var(--accent);background:var(--accent-dim)}
.vs-speed-wrap{display:flex;align-items:center;gap:6px;flex:1}
.vs-speed-range{flex:1;accent-color:var(--accent)}
.vs-speed-val{font-size:11px;color:var(--fg2);min-width:36px;text-align:right}
.vs-note{font-size:10px;color:var(--fg3);font-style:italic;padding:2px 0}
/* ── Waveform ──────────────────────────────────────── */
.va-waveform{display:flex;align-items:center;justify-content:center;gap:3px;height:44px;background:var(--bg2);border-radius:8px;padding:0 8px}
.va-wave-bar{width:3px;height:4px;border-radius:999px;background:var(--accent);transition:height 0.05s ease;will-change:height;flex-shrink:0}
.va-waveform.paused .va-wave-bar{background:var(--fg3)!important;height:4px!important}
/* ── Exchange ──────────────────────────────────────── */
.voice-exchange{display:flex;flex-direction:column;gap:3px;font-size:12px;line-height:1.5;max-height:72px;overflow-y:auto;padding:2px 0}
.voice-you{color:var(--fg)}
.voice-agent-line{color:var(--fg2)}
.voice-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--fg3);margin-right:4px}
.voice-error{font-size:11px;color:var(--danger);padding:4px 8px;background:rgba(220,38,38,.08);border-radius:6px}
.composer-wrap{flex:1;display:flex;flex-direction:column;gap:8px}
.attach-strip{display:flex;flex-wrap:wrap;gap:8px}
/* rejected-upload alert (Round 3): a specific, dismissable reason per file */
.upload-reject{display:flex;align-items:flex-start;gap:8px;padding:8px 12px;border-radius:10px;background:var(--danger-zone-bg);border:1px solid var(--danger-zone-border);color:var(--danger-zone-fg);font-size:12.5px;line-height:1.45}
.upload-reject-icon{flex:none}
.upload-reject-text{flex:1;min-width:0}
.upload-reject-x{flex:none;width:20px;height:20px;border:none;background:transparent;color:var(--danger-zone-fg);cursor:pointer;font-size:15px;line-height:1;border-radius:6px}
.upload-reject-x:hover{background:var(--danger-zone-border)}
.attach-chip{display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--bg3);border:1px solid var(--bg4);border-radius:999px;font-size:12px;color:var(--fg2);max-width:340px}
.attach-chip .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.attach-chip .remove{width:18px;height:18px;border-radius:999px;background:var(--bg2);border:1px solid var(--bg4);display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--fg3)}
.attach-chip .remove:hover{color:var(--danger);border-color:var(--danger)}
.msg-attachments{display:flex;flex-direction:column;gap:8px;margin-top:8px}
.msg-attachment{border:1px solid var(--bg4);background:var(--bg3);border-radius:10px;padding:8px 10px;font-size:12px;color:var(--fg2)}
.msg-attachment .title{font-weight:700;color:var(--fg);margin-bottom:2px}
.msg-attachment audio{width:100%;margin-top:6px}
.msg-attachment pre{max-height:180px;overflow:auto;margin-top:6px;background:var(--bg2);border:1px solid var(--bg4);border-radius:8px;padding:8px}

/* ── Artifact cards (m77 Phase 1 / Phase 2 type-aware) ───────── */
.artifact-cards{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.artifact-card{display:flex;align-items:center;gap:8px;background:var(--bg2);border:1px solid var(--bg4);border-radius:10px;padding:8px 12px;font-size:12px;color:var(--fg);text-decoration:none;cursor:pointer;transition:border-color .15s,background .15s;max-width:340px;min-width:160px}
.artifact-card:hover{border-color:var(--accent);background:var(--bg3)}
.artifact-card .ac-icon{width:18px;height:18px;flex-shrink:0;display:flex;align-items:center;justify-content:center;color:var(--fg3)}
.artifact-card .ac-icon svg{width:18px;height:18px;display:block}
.artifact-card .ac-body{min-width:0;flex:1}
.artifact-card .ac-name{font-weight:600;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px}
.artifact-card .ac-meta{color:var(--fg3);font-size:11px;margin-top:1px;display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.artifact-card .ac-badge{display:inline-block;padding:1px 5px;border-radius:4px;font-size:10px;font-weight:600;background:var(--accent-dim);color:var(--accent2);border:1px solid rgba(42,176,144,.2);line-height:1.4}
.artifact-card .ac-badge.lang{background:rgba(100,100,255,.12);color:#8888ff;border-color:rgba(100,100,255,.2)}
.artifact-card .ac-actions{display:flex;align-items:center;gap:4px;flex-shrink:0;margin-left:2px}
.artifact-card .ac-dl{display:flex;align-items:center;justify-content:center;color:var(--accent);opacity:.8;padding:2px;line-height:1}
.artifact-card .ac-dl svg{width:13px;height:13px;display:block}
.artifact-card .ac-dl:hover{opacity:1}
.artifact-card .ac-preview{display:flex;align-items:center;justify-content:center;padding:3px 6px;border-radius:5px;background:var(--accent-dim);color:var(--accent2);border:1px solid rgba(42,176,144,.25);cursor:pointer;transition:background .12s;line-height:1}
.artifact-card .ac-preview svg{width:12px;height:12px;display:block}
.artifact-card .ac-preview:hover{background:rgba(42,176,144,.2)}

/* ── Artifact streaming progress (Phase 4 indicator on cards) ─── */
.artifact-card.streaming{border-color:rgba(255,160,60,.5);background:rgba(255,140,30,.04)}
.artifact-card .ac-stream-bar{position:absolute;bottom:0;left:0;height:2px;background:linear-gradient(90deg,var(--accent),#f97316);border-radius:0 0 10px 10px;transition:width .4s ease}
.artifact-card{position:relative;overflow:hidden}
.artifact-card .ac-badge.streaming{background:rgba(255,140,30,.15);color:#f97316;border-color:rgba(255,140,30,.3)}
/* Phase 6: live artifact badge on cards */
.artifact-card .ac-badge.live{background:rgba(29,109,222,.14);color:#4db6ff;border-color:rgba(77,182,255,.25);animation:live-pulse 2.5s ease-in-out infinite}
@keyframes live-pulse{0%,100%{opacity:1}50%{opacity:.6}}

/* ── Artifact preview modal (Phase 2-H + Phase 5 render frame) ─── */
.artifact-preview-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9000;display:flex;align-items:center;justify-content:center;animation:fadein .15s}
.artifact-preview-dialog{background:var(--bg1);border:1px solid var(--bg4);border-radius:14px;width:min(920px,96vw);max-height:92vh;display:flex;flex-direction:column;box-shadow:0 8px 40px rgba(0,0,0,.5);overflow:hidden}
.apm-header{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--bg4);flex-shrink:0}
.apm-icon{width:22px;height:22px;flex-shrink:0;display:flex;align-items:center;justify-content:center;color:var(--fg3)}
.apm-icon svg{width:22px;height:22px;display:block}
.apm-title{font-weight:700;font-size:15px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.apm-type{font-size:11px;color:var(--fg3);padding:2px 6px;border-radius:5px;background:var(--bg3);border:1px solid var(--bg4)}
.apm-close{margin-left:auto;background:none;border:none;color:var(--fg2);font-size:22px;cursor:pointer;line-height:1;padding:0 4px;flex-shrink:0}
.apm-close:hover{color:var(--fg)}
.apm-body{flex:1;overflow:hidden;padding:0;position:relative;min-height:200px;display:flex;flex-direction:column}
/* Phase 5: full-height render frame — server-side sandboxed HTML */
.apm-render-frame{width:100%;flex:1;min-height:460px;border:none;display:block;background:#0e1117}
.apm-body .apm-loading{display:flex;align-items:center;justify-content:center;padding:40px;color:var(--fg3);font-size:13px}
.apm-footer{padding:10px 18px;border-top:1px solid var(--bg4);display:flex;align-items:center;gap:8px;flex-shrink:0;flex-wrap:wrap}
.apm-footer .apm-dl-btn{padding:5px 14px;background:var(--accent-dim);color:var(--accent2);border:1px solid rgba(42,176,144,.3);border-radius:7px;font-size:12px;font-weight:600;text-decoration:none;cursor:pointer}
.apm-footer .apm-dl-btn:hover{background:rgba(42,176,144,.2)}
.apm-footer .apm-admin-link{color:var(--fg3);font-size:12px;text-decoration:none;margin-left:auto}
.apm-footer .apm-admin-link:hover{color:var(--fg)}
/* Fullscreen toggle for the preview */
.apm-footer .apm-fullscreen-btn{padding:5px 10px;background:var(--bg3);color:var(--fg2);border:1px solid var(--bg4);border-radius:7px;font-size:11px;cursor:pointer}
.apm-footer .apm-fullscreen-btn:hover{background:var(--bg4)}
/* Phase 6: Refresh button for live artifact preview modal */
.apm-footer .apm-refresh-btn{padding:5px 12px;background:rgba(29,109,222,.12);color:#4db6ff;border:1px solid rgba(77,182,255,.25);border-radius:7px;font-size:12px;font-weight:600;cursor:pointer;transition:background .15s}
.apm-footer .apm-refresh-btn:hover{background:rgba(29,109,222,.22)}
.apm-footer .apm-refresh-btn:disabled{opacity:.5;cursor:default}
.apm-footer .apm-share-btn{padding:5px 12px;background:rgba(168,85,247,.12);color:#c084fc;border:1px solid rgba(192,132,252,.25);border-radius:7px;font-size:12px;font-weight:600;cursor:pointer;transition:background .15s}
.apm-footer .apm-share-btn:hover{background:rgba(168,85,247,.22)}
.apm-footer .apm-share-btn:disabled{opacity:.5;cursor:default}
.apm-footer .apm-embed-btn{padding:5px 12px;background:rgba(251,146,60,.12);color:#fb923c;border:1px solid rgba(251,146,60,.25);border-radius:7px;font-size:12px;font-weight:600;cursor:pointer;transition:background .15s}
.apm-footer .apm-embed-btn:hover{background:rgba(251,146,60,.22)}
.apm-footer .apm-embed-btn:disabled{opacity:.5;cursor:default}
/* ── Phase 7 Share Dialog ──────────────────────────────────── */
.share-dialog-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:10001;backdrop-filter:blur(4px)}
.share-dialog{background:var(--bg2);border:1px solid var(--bg4);border-radius:16px;padding:24px;width:min(480px,92vw);box-shadow:0 20px 60px rgba(0,0,0,.4);animation:sv-fadein .15s ease}
.share-dialog-title{font-size:15px;font-weight:700;color:var(--fg);margin-bottom:4px}
.share-dialog-sub{font-size:12px;color:var(--fg3);margin-bottom:16px}
.share-dialog-row{display:flex;gap:8px;align-items:center;margin-bottom:12px}
.share-dialog-url{flex:1;padding:8px 10px;background:var(--bg);border:1px solid var(--bg4);border-radius:8px;color:var(--fg2);font-size:12px;font-family:var(--mono);outline:none;min-width:0}
.share-dialog-copy{padding:7px 14px;background:var(--accent-dim);color:var(--accent2);border:1px solid rgba(42,176,144,.3);border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap}
.share-dialog-copy:hover{background:rgba(42,176,144,.2)}
.share-dialog-copy.copied{background:rgba(5,150,105,.2);color:#10b981;border-color:#10b981}
.share-dialog-embed{width:100%;padding:8px 10px;background:var(--bg);border:1px solid var(--bg4);border-radius:8px;color:var(--fg2);font-size:11px;font-family:var(--mono);resize:none;outline:none;margin-bottom:12px}
.share-dialog-actions{display:flex;justify-content:flex-end;gap:8px}
.share-dialog-close{padding:7px 16px;background:var(--bg3);color:var(--fg2);border:1px solid var(--bg4);border-radius:8px;font-size:12px;font-weight:600;cursor:pointer}
.share-dialog-close:hover{background:var(--bg4)}

/* ── Agent steps & tool calls ───────────– */
.step-card{background:var(--bg3);border:1px solid var(--bg4);border-radius:var(--radius);padding:12px 16px;margin:8px 0;font-size:13px}
.step-card .step-hdr{display:flex;align-items:center;gap:6px;color:var(--accent);font-weight:600;margin-bottom:4px;font-size:12px;text-transform:uppercase;letter-spacing:.3px}
.step-card .step-body{color:var(--fg2);white-space:pre-wrap;word-break:break-word;font-family:var(--mono);font-size:12px;max-height:200px;overflow-y:auto}

/* ── Process card ───────────────────– */
.process-card{background:var(--bg3);border:1px solid var(--bg4);border-radius:var(--radius);margin:8px 0;overflow:hidden}
.process-card.running{border-color:rgba(42,176,144,.22)}
.process-card .process-hdr{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 14px;background:rgba(0,0,0,.02)}
.process-card .process-title{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:700;color:var(--fg);text-transform:uppercase;letter-spacing:.3px}
.process-card .process-stage{display:inline-flex;align-items:center;gap:6px;font-size:10px;padding:2px 8px;border-radius:999px;background:var(--accent-dim);color:var(--accent2);border:1px solid rgba(42,176,144,.2)}
.process-card .process-stage-icon{font-size:11px;line-height:1}
.process-card .process-hdr-main{min-width:0;flex:1}
.process-card .process-meta{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.process-card .summary-chip{display:inline-flex;align-items:center;gap:4px;font-size:10px;padding:2px 8px;border-radius:999px;background:var(--bg2);border:1px solid var(--bg4);color:var(--fg2);font-family:var(--mono)}
.process-card .summary-chip.ok{background:rgba(22,163,74,.08);border-color:rgba(22,163,74,.18);color:var(--success)}
.process-card .summary-chip.warn{background:rgba(217,119,6,.08);border-color:rgba(217,119,6,.18);color:var(--warn)}
.process-card .summary-chip.deny{background:rgba(220,38,38,.08);border-color:rgba(220,38,38,.18);color:var(--danger)}
.process-card .process-toggle{font-size:11px;color:var(--fg2);border:1px solid var(--bg4);background:var(--bg2);padding:4px 10px;border-radius:999px}
.process-card .process-toggle:hover{color:var(--fg);border-color:var(--fg3)}
.process-card .process-toggle:focus-visible,.process-card .detail-toggle:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.process-card .process-summary{font-size:11px;color:var(--fg3);padding:9px 14px}
.process-card .process-body-wrap{display:grid;grid-template-rows:1fr;transition:grid-template-rows .22s ease,opacity .18s ease}
.process-card .process-body-wrap.collapsed{grid-template-rows:0fr;opacity:.72}
.process-card .process-body-clip{min-height:0;overflow:hidden}
.process-card .process-body{padding:10px 14px 12px;display:flex;flex-direction:column;gap:10px}
.process-card .process-body-wrap.collapsed .process-body{opacity:0;transform:translateY(-6px)}
.process-card .process-badge-row{display:flex;flex-wrap:wrap;gap:6px}
.process-card .process-section{border:1px solid var(--bg4);background:var(--bg2);border-radius:10px;padding:10px}
.process-card .process-section-title{font-size:10px;color:var(--fg3);text-transform:uppercase;letter-spacing:.3px;margin-bottom:8px}
.process-card .cse-lifecycle-section{border-color:rgba(42,176,144,.22);background:linear-gradient(180deg,rgba(42,176,144,.04),transparent)}
.process-card .cse-session-list{display:flex;flex-direction:column;gap:8px}
.process-card .cse-session-item{border:1px solid var(--bg4);background:var(--bg3);border-radius:10px;padding:8px 10px}
.process-card .cse-session-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.process-card .cse-session-id{font-size:11px;font-weight:700;color:var(--fg);font-family:var(--mono)}
.process-card .cse-session-meta{margin-top:4px;font-size:11px;color:var(--fg3)}
.process-card .live-thought{border:1px solid var(--bg4);background:var(--bg2);border-radius:10px;padding:8px 10px}
.process-card .live-thought .lbl{font-size:10px;color:var(--fg3);text-transform:uppercase;letter-spacing:.3px;margin-bottom:4px}
.process-card .live-thought .txt{font-size:12px;color:var(--fg2);line-height:1.45;white-space:pre-wrap;word-break:break-word;max-height:120px;overflow:auto}
.process-card .timeline{display:flex;flex-direction:column;gap:6px}
.process-card .worker-trace-section{border-color:rgba(217,119,6,.24);background:linear-gradient(180deg,rgba(217,119,6,.04),transparent)}
.process-card .worker-trace-summary{font-size:11px;color:var(--fg3);margin-bottom:8px}
.process-card .timeline-badges{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.process-card .timeline-badge{display:inline-flex;align-items:center;gap:4px;font-size:10px;padding:2px 8px;border-radius:999px;background:var(--bg3);border:1px solid var(--bg4);color:var(--fg2);font-family:var(--mono)}
.process-card .timeline-badge.ok{background:rgba(22,163,74,.08);border-color:rgba(22,163,74,.18);color:var(--success)}
.process-card .timeline-badge.warn{background:rgba(217,119,6,.08);border-color:rgba(217,119,6,.18);color:var(--warn)}
.process-card .timeline-badge.deny{background:rgba(220,38,38,.08);border-color:rgba(220,38,38,.18);color:var(--danger)}
.process-card .timeline-item{border:1px solid var(--bg4);background:var(--bg2);border-radius:10px;padding:8px 10px}
.process-card .timeline-item .t-h{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:11px;font-weight:600;color:var(--fg)}
.process-card .timeline-item .t-summary{margin-top:4px;font-size:11px;color:var(--fg2);line-height:1.45;white-space:pre-wrap;word-break:break-word}
.process-card .timeline-item .t-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.process-card .detail-toggle{font-size:10px;color:var(--fg2);border:1px solid var(--bg4);background:var(--bg3);padding:3px 8px;border-radius:999px}
.process-card .detail-toggle:hover{color:var(--fg);border-color:var(--fg3)}
.process-card .timeline-item .t-raw{margin-top:8px;background:var(--bg3);border:1px solid var(--bg4);border-radius:8px;padding:8px}
.process-card .timeline-item .t-raw-label{font-size:10px;color:var(--fg3);text-transform:uppercase;letter-spacing:.3px;margin-bottom:5px}
.process-card .timeline-item .t-b{font-size:11px;color:var(--fg2);white-space:pre-wrap;word-break:break-word;font-family:var(--mono);max-height:160px;overflow:auto}
.process-card .detail-block{border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);overflow:hidden}
.process-card .detail-block-hdr{display:flex;align-items:center;justify-content:space-between;padding:6px 8px;border-bottom:1px solid var(--bg4);background:var(--bg3)}
.process-card .detail-lang{font-size:10px;font-weight:700;letter-spacing:.3px;color:var(--fg3);text-transform:uppercase}
.process-card .detail-kind{font-size:10px;color:var(--fg3)}
.process-card .detail-block-actions{display:flex;align-items:center;gap:6px}
.process-card .detail-copy-btn{font-size:10px;line-height:1;border:1px solid var(--bg4);background:var(--bg2);color:var(--fg2);border-radius:999px;padding:4px 8px;cursor:pointer}
.process-card .detail-copy-btn:hover{border-color:var(--fg3);color:var(--fg)}
.process-card .detail-copy-btn.copied{border-color:rgba(22,163,74,.25);background:rgba(22,163,74,.1);color:var(--success)}
.process-card .detail-code{margin:0;padding:8px 10px;font-size:11px;line-height:1.45;color:var(--fg2);font-family:var(--mono);white-space:pre;overflow:auto;max-height:260px}
.process-card .detail-table-wrap{overflow:auto;max-height:280px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2)}
.process-card .detail-table{width:100%;border-collapse:separate;border-spacing:0;font-size:11px}
.process-card .detail-table th,.process-card .detail-table td{padding:6px 8px;border-bottom:1px solid var(--bg4);border-right:1px solid var(--bg4);text-align:left;vertical-align:top}
.process-card .detail-table th:last-child,.process-card .detail-table td:last-child{border-right:0}
.process-card .detail-table th{position:sticky;top:0;background:var(--bg3);color:var(--fg);font-weight:700;z-index:1}
.process-card .detail-table td{color:var(--fg2);font-family:var(--mono);white-space:pre-wrap;word-break:break-word;max-width:360px}
.process-card .timeline-item.thought{border-color:rgba(42,176,144,.25)}
.process-card .timeline-item.tool{border-color:rgba(217,119,6,.25)}
.process-card .timeline-item.worker{background:rgba(217,119,6,.03);border-style:dashed}
.process-card .timeline-item.delegation{border-color:rgba(124,58,237,.25)}
.process-card .timeline-item.response{border-color:rgba(59,130,246,.2)}
.process-card.running .process-stage{animation:processPulse 1.8s ease-in-out infinite}

/* Ensemble section */
.process-card .ensemble-section{border-color:rgba(124,58,237,.22);background:linear-gradient(180deg,rgba(124,58,237,.04),transparent)}
.process-card .ensemble-rationale{font-size:11px;color:var(--fg2);margin-bottom:10px;padding:8px 10px;background:var(--bg3);border:1px solid rgba(124,58,237,.18);border-radius:8px;line-height:1.5}
.process-card .ensemble-candidates{display:flex;flex-direction:column;gap:8px}
.process-card .ensemble-candidate{border:1px solid var(--bg4);background:var(--bg2);border-radius:10px;padding:8px 10px}
.process-card .ensemble-candidate.winner{border-color:rgba(124,58,237,.4);background:rgba(124,58,237,.04)}
.process-card .ensemble-candidate-hdr{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}
.process-card .ensemble-agent-name{font-size:11px;font-weight:700;color:var(--fg);font-family:var(--mono)}
.process-card .ensemble-winner-badge{font-size:10px;padding:2px 8px;border-radius:999px;background:rgba(124,58,237,.12);border:1px solid rgba(124,58,237,.3);color:rgb(124,58,237)}
.process-card .ensemble-candidate-output{font-size:11px;color:var(--fg2);line-height:1.5;white-space:pre-wrap;word-break:break-word}

/* Reflection section */
.process-card .reflect-section{border-color:rgba(59,130,246,.22);background:linear-gradient(180deg,rgba(59,130,246,.04),transparent)}
.process-card .reflect-list{display:flex;flex-direction:column;gap:8px}
.process-card .reflect-item{border:1px solid rgba(59,130,246,.2);background:var(--bg2);border-radius:10px;padding:8px 10px}
.process-card .reflect-item-hdr{font-size:10px;font-weight:700;color:rgb(59,130,246);text-transform:uppercase;letter-spacing:.3px;margin-bottom:5px}
.process-card .reflect-feedback{font-size:11px;color:var(--fg2);line-height:1.5;white-space:pre-wrap;word-break:break-word}

/* Evaluator/verify section */
.process-card .verify-section{border-color:rgba(234,88,12,.22);background:linear-gradient(180deg,rgba(234,88,12,.04),transparent)}
.process-card .verify-list{display:flex;flex-direction:column;gap:8px}
.process-card .verify-item{border:1px solid var(--bg4);background:var(--bg2);border-radius:10px;padding:8px 10px}
.process-card .verify-item-hdr{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;font-weight:600;color:var(--fg);margin-bottom:4px}
.process-card .verify-reason{font-size:11px;color:var(--fg2);line-height:1.5;white-space:pre-wrap;word-break:break-word}

.skill-list{display:flex;flex-direction:column;gap:8px}
.skill-item{border:1px solid rgba(42,176,144,.25);background:var(--bg2);border-radius:10px;padding:8px 10px}
.skill-item-top{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:3px}
.skill-name{font-size:12px;font-weight:700;color:var(--fg)}
.skill-score{font-size:10px;font-family:var(--mono);color:var(--accent2);background:var(--accent-dim);border:1px solid rgba(42,176,144,.2);border-radius:999px;padding:2px 8px}
.skill-category{font-size:10px;color:var(--fg3);text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px}
.skill-tags{display:flex;flex-wrap:wrap;gap:4px}
.skill-tag{font-size:10px;padding:2px 8px;border-radius:999px;background:var(--bg3);border:1px solid var(--bg4);color:var(--fg2);font-family:var(--mono)}
.skill-summary{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px}
.skill-summary .skill-tag{background:var(--accent-dim);border-color:rgba(42,176,144,.22);color:var(--accent2)}

.validation-list{display:flex;flex-direction:column;gap:8px}
.validation-item{border:1px solid var(--bg4);background:var(--bg3);border-radius:10px;padding:8px 10px}
.validation-item.ok{border-color:rgba(22,163,74,.2)}
.validation-item.warn{border-color:rgba(217,119,6,.22)}
.validation-item.deny{border-color:rgba(220,38,38,.24)}
.validation-item-top{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px}
.validation-name{font-size:12px;font-weight:700;color:var(--fg)}
.validation-status{font-size:10px;padding:2px 8px;border-radius:999px;border:1px solid var(--bg4);text-transform:uppercase;letter-spacing:.3px}
.validation-status.ok{background:rgba(22,163,74,.08);border-color:rgba(22,163,74,.18);color:var(--success)}
.validation-status.warn{background:rgba(217,119,6,.08);border-color:rgba(217,119,6,.18);color:var(--warn)}
.validation-status.deny{background:rgba(220,38,38,.08);border-color:rgba(220,38,38,.18);color:var(--danger)}
.validation-body{font-size:11px;color:var(--fg2);line-height:1.45;white-space:pre-wrap;word-break:break-word}

.mode-badge{display:inline-flex;align-items:center;gap:4px;font-size:10px;padding:3px 10px;border-radius:999px;background:var(--accent-dim);color:var(--accent);text-transform:uppercase;letter-spacing:.5px;font-weight:600;border:1px solid rgba(37,99,235,.15)}

.streaming-indicator span{animation:blink 1.4s infinite both}
.streaming-indicator span:nth-child(2){animation-delay:.2s}
.streaming-indicator span:nth-child(3){animation-delay:.4s}

@keyframes processPulse{0%,100%{box-shadow:0 0 0 0 rgba(42,176,144,0)}50%{box-shadow:0 0 0 4px rgba(42,176,144,.08)}}
@keyframes blink{0%,80%,100%{opacity:.2}40%{opacity:1}}

/* ── Dropdown wrapper ───────────────────── */
.dropdown-anchor{position:relative}
.dropdown{position:fixed;background:var(--bg2);border:1px solid var(--bg4);border-radius:var(--radius-lg);box-shadow:var(--shadow-hover);z-index:10000;min-width:200px;max-height:calc(100vh - 80px);overflow-y:auto;animation:dropIn .15s ease-out}
@keyframes dropIn{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}

/* ── Profile dropdown ───────────────────── */
.profile-dd{width:260px;padding:20px}
.profile-dd .pf-name{font-size:15px;font-weight:600;margin-bottom:2px;color:var(--fg)}
.profile-dd .pf-email{font-size:13px;color:var(--fg3);margin-bottom:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.profile-dd .pf-divider{height:1px;background:var(--bg4);margin:10px 0}
.profile-dd .pf-btn{display:block;width:100%;text-align:left;padding:10px 12px;border-radius:var(--radius);font-size:14px;color:var(--fg2);background:none;transition:all .18s ease}
.profile-dd .pf-btn:hover{background:var(--bg3);color:var(--fg)}
.profile-dd .pf-btn.danger{color:var(--danger)}
.profile-dd .pf-btn.danger:hover{background:rgba(220,38,38,.06)}

/* ── Settings panel ────────────────────– */
.settings-dd{width:380px;padding:24px;max-height:82vh;overflow-y:auto}
.settings-dd h3{font-size:15px;font-weight:600;margin-bottom:16px;display:flex;align-items:center;gap:8px;color:var(--fg)}
.mode-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.mode-card{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:var(--radius);border:1px solid var(--bg4);background:var(--bg2);cursor:pointer;transition:all .18s ease}
.mode-card:hover{border-color:var(--fg3);background:var(--bg3)}
.mode-card.selected{border-color:var(--accent);background:var(--accent-dim)}
.mode-card .mc-icon{font-size:16px;width:24px;text-align:center;flex:0 0 auto}
.mode-card .mc-title{font-size:12px;font-weight:600;color:var(--fg)}
.mode-card .mc-desc{font-size:10px;color:var(--fg3);margin-top:1px;line-height:1.3}
.setting-row{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:var(--radius);border:1px solid var(--bg4);background:var(--bg2);cursor:pointer;transition:border-color .18s}
.setting-row:hover{border-color:var(--fg3)}
.setting-row-label{font-size:13px;font-weight:600;color:var(--fg)}
.setting-row-desc{font-size:11px;color:var(--fg3);margin-top:2px}
.setting-sub{display:flex;align-items:center;justify-content:space-between;padding:5px 12px 5px 22px;font-size:12px;color:var(--fg2)}
.setting-sub input[type=number]{width:56px;text-align:center;padding:3px 6px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg3);color:var(--fg);font-size:12px;font-family:inherit}
.setting-section-label{font-size:10px;color:var(--fg3);font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-top:4px}
.setting-sep{height:1px;background:var(--bg4);margin:6px 0}
.resolver-option{display:flex;align-items:center;gap:8px;padding:5px 2px;cursor:pointer;font-size:12px;color:var(--fg)}
.resolver-dot{width:14px;height:14px;border-radius:50%;border:2px solid var(--fg3);background:transparent;flex:0 0 auto;transition:all .15s}
.resolver-dot.active{border-color:var(--accent);background:var(--accent)}
.toggle-switch{position:relative;width:36px;height:20px;background:var(--bg4);border-radius:10px;cursor:pointer;transition:background .2s}
.toggle-switch.on{background:var(--accent)}
.toggle-switch::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;background:#fff;border-radius:50%;transition:transform .2s}
.toggle-switch.on::after{transform:translateX(16px)}

/* ── Dashboard ──────────────────────────────── */
.dash-view{flex:1;overflow-y:auto;padding:32px}
.dash-view h2{font-size:22px;font-weight:700;margin-bottom:24px;color:var(--fg)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px;margin-bottom:32px}
.card{background:var(--bg2);border:1px solid var(--bg4);border-radius:var(--radius-lg);padding:24px;box-shadow:var(--shadow-soft);transition:box-shadow .18s ease}
.card:hover{box-shadow:var(--shadow-hover)}
.card .label{font-size:12px;color:var(--fg3);margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px;font-weight:500}
.card .value{font-size:28px;font-weight:700;color:var(--fg)}
.card .value.cost{color:var(--success)}
.card .value.tokens{color:var(--accent)}
.card .value.latency{color:var(--warn)}
.charts{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:32px}
.chart-box{background:var(--bg2);border:1px solid var(--bg4);border-radius:var(--radius-lg);padding:24px;box-shadow:var(--shadow-soft)}
.chart-box h3{font-size:14px;color:var(--fg2);margin-bottom:12px;font-weight:600}
.chart-box canvas{width:100%;height:200px}
.eval-table{width:100%;border-collapse:collapse;font-size:13px}
.eval-table th,.eval-table td{padding:10px 14px;text-align:left;border-bottom:1px solid var(--bg4);vertical-align:middle}
.eval-table th{color:var(--fg3);font-weight:500;text-transform:uppercase;font-size:11px;letter-spacing:.5px}
.eval-table td{color:var(--fg2)}
.table-wrap{background:var(--bg2);border:1px solid var(--bg4);border-radius:var(--radius-lg);overflow:hidden;box-shadow:var(--shadow-soft)}
.table-wrap h3{font-size:14px;color:var(--fg2);padding:20px 20px 0;font-weight:600}
.admin-main-panel{display:flex;flex-direction:column;gap:12px;min-width:0}
.admin-content-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;align-items:start}
.admin-content-grid.editing{grid-template-columns:minmax(0,1fr) minmax(300px,380px)}
.admin-list-panel{min-width:0}
.admin-list-header{display:flex;align-items:center;justify-content:space-between;padding:20px 20px 0}
.admin-list-header h3{margin:0;font-size:14px;color:var(--fg2);font-weight:600}
.admin-list-toolbar{display:flex;align-items:center;gap:10px;padding:14px 20px 10px;flex-wrap:wrap;justify-content:flex-end}
.admin-list-search-wrap{position:relative;width:260px;min-width:180px;flex:1 1 260px;max-width:360px}
.admin-list-search-icon{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--fg3);font-size:13px;pointer-events:none;line-height:1}
.admin-list-search{width:100%;padding:6px 10px 6px 28px;border-radius:9px;border:1px solid var(--bg4);background:var(--bg3);color:var(--fg);font-size:12px;box-sizing:border-box}
.admin-list-search:focus{border-color:var(--accent);outline:none;box-shadow:0 0 0 3px color-mix(in oklab,var(--accent) 18%, transparent)}
.fast-tip{position:fixed;background:var(--bg2);color:var(--fg);border:1px solid var(--bg4);border-radius:8px;padding:6px 10px;font-size:11px;white-space:nowrap;box-shadow:0 4px 16px rgba(0,0,0,.3);pointer-events:none;z-index:10000;opacity:0;transform:translateY(-2px);transition:opacity .08s ease, transform .08s ease}
.fast-tip.show{opacity:1;transform:translateY(0)}
.admin-list-groupby{padding:8px 10px;border-radius:9px;border:1px solid var(--bg4);background:var(--bg3);color:var(--fg);font-size:12px;cursor:pointer;white-space:nowrap}
.admin-grouped-hint{font-size:11px;color:var(--accent2);background:var(--accent-dim);border:1px solid var(--accent);border-radius:7px;padding:4px 10px;white-space:nowrap;user-select:none}
.admin-exclude-hint{color:var(--warn,#e88);border-color:var(--warn,#e88);background:color-mix(in oklab,var(--warn,#e88) 12%, var(--bg2));cursor:pointer}
.admin-exclude-hint:hover{opacity:.8}
.eval-table td[oncontextmenu]:hover{background:color-mix(in oklab,var(--accent) 7%, transparent);cursor:context-menu}
.eval-table th.col-grouped{color:var(--accent2)}
.col-group-badge{font-size:10px;margin-left:4px;color:var(--accent2);vertical-align:middle}
.col-ctx-menu{position:fixed;z-index:9999;background:var(--bg2);border:1px solid var(--bg4);border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.35),0 2px 8px rgba(0,0,0,.2);padding:6px 0;min-width:200px;max-width:280px;font-size:13px;animation:ctx-pop .12s ease}
@keyframes ctx-pop{from{opacity:0;transform:scale(.95) translateY(-4px)}to{opacity:1;transform:scale(1) translateY(0)}}
@keyframes admin-toast-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.col-ctx-header{padding:5px 14px 3px;font-size:10px;font-weight:700;letter-spacing:.08em;color:var(--fg3);user-select:none}
.col-ctx-sep{height:1px;background:var(--bg4);margin:4px 0}
.col-ctx-item{display:flex;align-items:center;gap:8px;padding:7px 14px;cursor:pointer;color:var(--fg2);border-radius:0;transition:background .1s}
.col-ctx-item:hover{background:color-mix(in oklab,var(--accent) 10%, var(--bg3));color:var(--fg)}
.col-ctx-item.ctx-active{color:var(--accent2);font-weight:600}
.col-ctx-item.ctx-active:hover{background:var(--accent-dim)}
.col-ctx-item.ctx-disabled{opacity:.38;cursor:default;pointer-events:none}
.col-ctx-item.ctx-danger{color:#e05252}
.col-ctx-item.ctx-danger:hover{background:color-mix(in oklab,#e05252 12%, var(--bg3))}
.col-ctx-item.ctx-has-submenu{padding-right:10px}
.ctx-icon{width:16px;text-align:center;font-size:12px;color:var(--fg3);flex-shrink:0}
.col-ctx-item.ctx-active .ctx-icon{color:var(--accent2)}
.ctx-caret{margin-left:auto;color:var(--fg3);font-size:12px;line-height:1}
.col-ctx-submenu{min-width:170px;max-width:240px}
.admin-list-footer{display:flex;align-items:center;justify-content:space-between;padding:12px 20px;border-top:1px solid var(--bg4);background:var(--bg2);gap:12px;flex-wrap:wrap}
.admin-list-info{font-size:12px;color:var(--fg3)}
.admin-list-pagination{display:flex;align-items:center;gap:4px}
.admin-page-btn{padding:5px 10px;font-size:12px;border-radius:7px;border:1px solid var(--bg4);background:var(--bg3);color:var(--fg2);cursor:pointer;min-width:32px;text-align:center}
.admin-page-btn:hover:not([disabled]){background:var(--bg);color:var(--fg);border-color:var(--fg3)}
.admin-page-btn[disabled]{opacity:.4;cursor:default;pointer-events:none}
.admin-page-btn.active{background:var(--accent-dim);color:var(--accent2);border-color:var(--accent);font-weight:700}
.admin-page-ellipsis{font-size:12px;color:var(--fg3);padding:0 4px;line-height:1}
.eval-table th.sortable{cursor:pointer;user-select:none;white-space:nowrap}
.eval-table th.sortable:hover{color:var(--fg);background:color-mix(in oklab,var(--bg4) 55%, transparent)}
.eval-table th.sort-active{color:var(--accent2)}
.sort-indicator{font-size:10px;opacity:.55;display:inline-block}
.eval-table th.sort-active .sort-indicator{opacity:1}
.admin-group-header-row td{background:color-mix(in oklab,var(--bg4) 55%, var(--bg2));color:var(--fg2);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:7px 14px;cursor:pointer;user-select:none}
.admin-group-header-row td:hover{background:var(--bg4)}
.admin-group-count{font-size:10px;font-weight:400;color:var(--fg3);margin-left:8px;text-transform:none;letter-spacing:0}
.admin-editor-panel{position:sticky;top:16px;align-self:start}
.admin-editor-panel .chart-box{margin:0}
.admin-detail-panel .chart-box{margin:0}
.admin-breadcrumbs{display:flex;align-items:center;gap:10px;padding:9px 12px;border:1px solid var(--bg4);border-radius:10px;background:var(--bg2);font-size:12px;color:var(--fg2)}
.admin-breadcrumb-back{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border:1px solid transparent;background:transparent;color:var(--fg2);border-radius:999px;padding:0;font-weight:700;line-height:1;cursor:pointer}
.admin-breadcrumb-back:hover{background:var(--bg3);color:var(--fg);border-color:var(--bg4)}
.admin-breadcrumb-back:focus-visible,.admin-breadcrumb-link:focus-visible{outline:2px solid color-mix(in oklab,var(--accent) 78%, white);outline-offset:2px}
.admin-breadcrumb-list{list-style:none;display:flex;align-items:center;gap:0;margin:0;padding:0;min-width:0;flex-wrap:nowrap}
.admin-breadcrumb-item{display:inline-flex;align-items:center;min-width:0;color:var(--fg2)}
.admin-breadcrumb-item + .admin-breadcrumb-item::before{content:'›';margin:0 8px;color:var(--fg3);font-weight:700}
.admin-breadcrumb-link{border:1px solid transparent;background:transparent;color:var(--accent2);border-radius:6px;padding:2px 4px;font-weight:600;cursor:pointer;white-space:nowrap}
.admin-breadcrumb-link:hover{background:var(--bg3);border-color:var(--bg4);color:var(--fg)}
.admin-breadcrumb-item-current{color:var(--fg);font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:min(52vw,420px)}
.row-actions{display:flex;gap:8px;align-items:center}
.row-btn{padding:4px 10px;font-size:12px;border-radius:6px;border:1px solid var(--bg4);background:var(--bg3);color:var(--fg);cursor:pointer}
.row-btn:hover{border-color:var(--fg3);background:var(--bg)}
.row-btn-edit{color:var(--accent2);border-color:var(--accent);background:var(--accent-dim)}
.row-btn-del{color:#DC2626;border-color:#FCA5A5;background:#FEF2F2}
.admin-data-row{cursor:pointer;transition:background .1s}
.admin-data-row:hover td{background:color-mix(in oklab,var(--accent) 7%, transparent)}
.admin-data-row-selected td{background:color-mix(in oklab,var(--accent) 16%, transparent)}
.admin-data-row-selected:hover td{background:color-mix(in oklab,var(--accent) 20%, transparent)}
.admin-col-mgr-btn{font-size:11px;padding:3px 10px;gap:5px}
.admin-col-manager{background:var(--bg2);border:1px solid var(--bg4);border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.35),0 2px 8px rgba(0,0,0,.18);padding:8px 0 6px;min-width:220px;max-width:300px;font-size:13px;animation:ctx-pop .12s ease}
.admin-col-manager-header{display:flex;align-items:center;justify-content:space-between;padding:4px 14px 8px;border-bottom:1px solid var(--bg4);margin-bottom:4px;font-weight:600;color:var(--fg)}
.admin-col-manager-reset{font-size:11px;padding:2px 8px;border-radius:6px;background:var(--bg3);border:1px solid var(--bg4);color:var(--fg3);cursor:pointer}
.admin-col-manager-reset:hover{background:var(--bg4);color:var(--fg)}
.admin-col-manager-section-label{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--fg3);padding:6px 14px 2px}
.admin-col-manager-section-label-hidden{padding-top:10px;border-top:1px solid var(--bg4);margin-top:4px}
.admin-col-manager-item{display:flex;align-items:center;gap:4px;padding:4px 10px 4px 14px;transition:background .1s}
.admin-col-manager-item:hover{background:color-mix(in oklab,var(--accent) 8%, var(--bg3))}
.admin-col-manager-item-hidden .admin-col-manager-name{color:var(--fg3)}
.admin-col-manager-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg2)}
.admin-col-manager-btn{font-size:12px;padding:1px 6px;border-radius:5px;background:var(--bg3);border:1px solid var(--bg4);color:var(--fg3);cursor:pointer;line-height:1.5;min-width:22px;text-align:center}
.admin-col-manager-btn:hover:not(:disabled){background:var(--accent-dim);border-color:var(--accent);color:var(--accent2)}
.admin-col-manager-btn:disabled{opacity:.3;cursor:default}
.admin-col-manager-hide:hover:not(:disabled){background:color-mix(in oklab,#e05252 12%, var(--bg3));border-color:#e05252;color:#e05252}
.admin-col-manager-add:hover:not(:disabled){background:color-mix(in oklab,var(--accent) 14%, var(--bg3));border-color:var(--accent);color:var(--accent2)}
.admin-form-action-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid var(--bg4)}
.admin-form-title{font-size:15px;font-weight:700;color:var(--fg)}
.admin-form-action-btns{display:flex;align-items:center;gap:8px}
.admin-form-btn{padding:6px 16px;font-size:13px;border-radius:8px;border:1px solid var(--bg4);background:var(--bg3);color:var(--fg);cursor:pointer;font-weight:500;transition:background .1s,border-color .1s}
.admin-form-btn:hover{background:var(--bg);border-color:var(--fg3)}
.admin-form-btn-save{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
.admin-form-btn-save:hover{opacity:.88;background:var(--accent)}
.admin-form-btn-delete{color:#DC2626;border-color:#FCA5A5;background:#FEF2F2}
.admin-form-btn-delete:hover{background:#FEE2E2;border-color:#F87171}
.admin-form-btn-share{color:var(--fg2);border-color:var(--bg4);background:var(--bg2)}
.admin-form-btn-share:hover{background:var(--bg3);color:var(--fg)}
/* Copied toast */
.admin-share-toast{background:var(--bg3);color:var(--fg);border:1px solid var(--bg4);border-radius:8px;padding:5px 12px;font-size:12px;font-weight:600;pointer-events:none;white-space:nowrap;box-shadow:0 4px 12px rgba(0,0,0,.18);animation:admin-toast-in .15s ease}

/* ── Prompt Setup Wizard ─────────────────── */
.prompt-wizard{margin:12px 12px 18px;border:1px solid var(--bg4);background:linear-gradient(180deg,var(--bg2),var(--bg3))}
.prompt-wizard-head h3{margin:0 0 2px;font-size:16px;color:var(--fg)}
.prompt-wizard-sub{font-size:12px;color:var(--fg2)}
.prompt-wizard-top-actions{margin-top:8px}
.prompt-wizard-mode{margin-top:8px;font-size:12px;color:var(--fg2);padding:6px 10px;border:1px dashed var(--bg4);border-radius:8px;background:var(--bg2)}
.prompt-wizard-section{margin-top:16px;padding:14px;border:1px solid var(--bg4);border-radius:12px;background:var(--bg)}
.prompt-wizard-section h4{margin:0 0 10px;font-size:13px;color:var(--fg)}
.prompt-wizard-section label{display:block;font-size:12px;color:var(--fg2);margin-bottom:4px;font-weight:600}
.prompt-wizard-section input[type="text"],.prompt-wizard-section select,.prompt-wizard-section textarea{width:100%;padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg)}
.prompt-wizard-section textarea{font-family:var(--mono)}
.prompt-wizard-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.prompt-wizard-inline{display:flex;gap:8px;align-items:center}
.prompt-wizard-inline select{flex:1}
.prompt-wizard-hint{font-size:12px;color:var(--fg3);margin-top:6px}
.prompt-token-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px;font-size:12px;color:var(--fg2)}
.prompt-token{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;border:1px solid var(--bg4);background:var(--bg2);font-size:11px;color:var(--fg2)}
.prompt-token-variable{background:var(--accent-dim);border-color:var(--accent);color:var(--accent2)}
.prompt-token-fragment{background:#edf9f5;border-color:#b9e9d8;color:#135e4a}
.prompt-token-fragment.warn{background:#fff7ed;border-color:#fed7aa;color:#9a3412}
.prompt-token-empty{background:var(--bg2);border-color:var(--bg4);color:var(--fg3)}
.prompt-template-preview{margin-top:8px;padding:10px;border:1px solid var(--bg4);border-radius:10px;background:var(--bg2);white-space:pre-wrap;word-break:break-word;color:var(--fg2);max-height:220px;overflow:auto}
.prompt-template-empty{color:var(--fg3);font-style:italic}
.prompt-wizard-checks{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px;margin-top:8px}
.prompt-wizard-checks label,.prompt-wizard-toggle{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:500;color:var(--fg2)}
.prompt-wizard-list{margin-top:10px;display:flex;flex-direction:column;gap:6px}
.prompt-wizard-list-item{display:flex;justify-content:space-between;align-items:center;padding:8px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);font-size:12px;color:var(--fg2)}
.prompt-section-item{align-items:flex-start;gap:10px}
.prompt-section-main{flex:1;display:flex;flex-direction:column;gap:8px}
.prompt-section-actions{display:flex;flex-direction:column;gap:6px;min-width:72px}
.prompt-wizard-actions{display:flex;gap:8px;margin-top:16px}
.prompt-wizard-status{margin-top:10px;font-size:12px;color:#0f766e;background:#ecfeff;border:1px solid #99f6e4;padding:8px;border-radius:8px}
.prompt-wizard-error{margin-top:10px;font-size:12px;color:#991b1b;background:#fef2f2;border:1px solid #fecaca;padding:8px;border-radius:8px}

/* ── Action Feed (WC1) ─────────────────── */
.af-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px 6px}
.af-title{font-size:12px;font-weight:600;color:var(--fg2);letter-spacing:.04em;text-transform:uppercase}
.af-title-row{display:flex;align-items:center;gap:6px}
.af-count{font-size:11px;font-weight:600;background:var(--accent);color:#fff;border-radius:999px;padding:1px 6px;line-height:1.4}
.af-loading{padding:12px;font-size:12px;color:var(--fg3);text-align:center}
.af-filters{display:flex;gap:4px;padding:0 12px 8px;flex-wrap:wrap}
.af-filter{font-size:11px;padding:3px 9px;border-radius:999px;border:1px solid var(--bg4);background:var(--bg2);color:var(--fg2);cursor:pointer;transition:background .15s}
.af-filter:hover{background:var(--bg3)}
.af-filter.active{background:var(--accent);color:#fff;border-color:var(--accent)}
.af-body{display:flex;flex-direction:column;gap:1px}
.af-row{display:flex;align-items:flex-start;gap:8px;padding:8px 12px;cursor:pointer;transition:background .15s;border-left:3px solid transparent;position:relative}
.af-row:hover{background:var(--bg2)}
.af-row[data-urgency="overdue"]{border-left-color:#ef4444}
.af-row[data-urgency="due-soon"]{border-left-color:#f59e0b}
.af-row[data-urgency="proposed"]{border-left-color:#3b82f6}
.af-badge{font-size:10px;font-weight:600;padding:2px 6px;border-radius:4px;white-space:nowrap;flex-shrink:0;margin-top:2px}
.af-badge[data-kind="approval"]{background:#dbeafe;color:#1d4ed8}
.af-badge[data-kind="task"]{background:#ede9fe;color:#7c3aed}
.af-badge[data-kind="reminder"]{background:#fef3c7;color:#92400e}
.af-badge[data-kind="agenda"]{background:#d1fae5;color:#065f46}
.af-row-body{flex:1;min-width:0}
.af-row-title{font-size:13px;color:var(--fg1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.af-row-due{font-size:11px;color:var(--fg3);margin-top:2px}
.af-row-due.overdue{color:#ef4444}
.af-row-due.due-soon{color:#f59e0b}
.af-more{padding:8px 12px;font-size:12px;color:var(--accent);text-align:center;cursor:pointer}
.af-more:hover{text-decoration:underline}

/* ── Calendar widget + full view (WC2-WC4) ─ */
.cal-bucket{margin-bottom:12px}
.cal-bucket-label{font-size:11px;font-weight:600;color:var(--fg3);text-transform:uppercase;letter-spacing:.05em;padding:4px 0 6px}
.cal-bucket-label.overdue{color:#ef4444}
.cal-bucket-label.today{color:var(--accent)}
.cal-bucket-list{display:flex;flex-direction:column;gap:4px}
.cal-item-chip{display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:6px;cursor:pointer;background:var(--bg2);transition:background .15s;border-left:3px solid var(--accent)}
.cal-item-chip:hover{background:var(--bg3)}
.cal-item-title{font-size:12px;color:var(--fg1);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cal-item-time{font-size:11px;color:var(--fg3);white-space:nowrap}
.cal-quick-add{display:flex;gap:6px;padding:8px 0 4px}
.cal-qa-input{flex:1;padding:6px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg1);font-size:12px}
.cal-qa-input:focus{outline:none;border-color:var(--accent)}
.cal-qa-btn{padding:6px 12px;border-radius:8px;background:var(--accent);color:#fff;font-size:12px;font-weight:600;border:none;cursor:pointer}
.cal-empty{color:var(--fg3);font-size:12px;padding:8px 0;text-align:center}
.cal-full-view{display:flex;flex-direction:column;height:100%;overflow:hidden}
.cal-top-bar{display:flex;align-items:center;justify-content:space-between;padding:12px 20px;border-bottom:1px solid var(--bg4);gap:12px;flex-shrink:0}
.cal-top-left{display:flex;align-items:center;gap:12px}
.cal-back-btn{font-size:12px;color:var(--fg3);background:none;border:none;cursor:pointer;padding:4px 8px;border-radius:6px}
.cal-back-btn:hover{background:var(--bg3);color:var(--fg1)}
.cal-month-nav{display:flex;align-items:center;gap:6px}
.cal-month-label{font-size:14px;font-weight:600;color:var(--fg1);min-width:140px;text-align:center}
.cal-nav-arrow{font-size:16px;background:none;border:none;cursor:pointer;color:var(--fg2);padding:2px 8px;border-radius:6px}
.cal-nav-arrow:hover{background:var(--bg3)}
.cal-today-btn{font-size:12px;padding:4px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg2);cursor:pointer}
.cal-today-btn:hover{background:var(--bg3)}
.cal-view-toggle{display:flex;gap:2px;background:var(--bg2);border:1px solid var(--bg4);border-radius:8px;padding:2px}
.cal-nav-btn{font-size:12px;padding:4px 12px;border:none;border-radius:6px;background:none;color:var(--fg2);cursor:pointer;transition:background .15s}
.cal-nav-btn:hover{background:var(--bg3)}
.cal-nav-btn.active{background:var(--accent);color:#fff}
.cal-qa-bar{display:flex;gap:8px;padding:12px 20px;border-bottom:1px solid var(--bg4);flex-shrink:0}
.cal-qa-full-input{flex:1;padding:8px 14px;border:1px solid var(--bg4);border-radius:10px;background:var(--bg2);color:var(--fg1);font-size:13px}
.cal-qa-full-input:focus{outline:none;border-color:var(--accent);background:var(--bg1)}
.cal-qa-submit{padding:8px 16px;border-radius:10px;background:var(--accent);color:#fff;font-size:13px;font-weight:600;border:none;cursor:pointer;white-space:nowrap}
.cal-qa-submit:hover{opacity:.88}
.cal-qa-submit:disabled{opacity:.5;cursor:not-allowed}
.cal-loading{padding:24px;text-align:center;color:var(--fg3);font-size:14px}
.cal-empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:48px 24px;flex:1}
.cal-empty-icon{font-size:40px}
.cal-empty-msg{font-size:16px;font-weight:600;color:var(--fg2)}
.cal-empty-sub{font-size:13px;color:var(--fg3);text-align:center}
/* Agenda sub-view */
.cal-agenda-view{flex:1;overflow-y:auto;padding:16px 20px}
.cal-sections{display:flex;flex-direction:column;gap:16px}
.cal-section{display:flex;flex-direction:column;gap:6px}
.cal-section-label{font-size:11px;font-weight:700;color:var(--fg3);text-transform:uppercase;letter-spacing:.06em;padding-bottom:4px;border-bottom:1px solid var(--bg4)}
.cal-section-label.overdue{color:#ef4444}
.cal-section-label.today{color:var(--accent)}
.cal-agenda-row{display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-bottom:1px solid var(--bg3)}
.cal-agenda-row:last-child{border-bottom:none}
.cal-agenda-color{width:4px;border-radius:2px;height:40px;flex-shrink:0;background:var(--accent)}
.cal-agenda-content{flex:1;min-width:0}
.cal-agenda-title{font-size:13px;font-weight:500;color:var(--fg1);margin-bottom:4px}
.cal-agenda-meta{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.cal-cat-chip{font-size:11px;padding:2px 8px;border-radius:4px;font-weight:500}
.cal-agenda-loc{font-size:11px;color:var(--fg3)}
.cal-agenda-amount{font-size:11px;color:var(--fg3)}
.cal-agenda-time{font-size:12px;color:var(--fg3);margin-top:4px}
.cal-agenda-edit{background:none;border:none;color:var(--fg3);cursor:pointer;padding:4px 8px;border-radius:6px;font-size:13px;flex-shrink:0;margin-top:4px}
.cal-agenda-edit:hover{background:var(--bg3);color:var(--fg1)}
/* Week sub-view */
.cal-week-view{flex:1;display:flex;flex-direction:column;overflow:hidden}
.cal-week-header{display:grid;grid-template-columns:52px repeat(7,1fr);border-bottom:1px solid var(--bg4);flex-shrink:0}
.cal-week-time-gutter{font-size:10px;color:var(--fg3);padding:6px 4px;text-align:right}
.cal-week-day-hdr{display:flex;flex-direction:column;align-items:center;padding:6px 4px;cursor:pointer;border-left:1px solid var(--bg4)}
.cal-week-day-hdr:hover{background:var(--bg2)}
.cal-week-dw{font-size:10px;color:var(--fg3);font-weight:600;text-transform:uppercase}
.cal-week-dn{font-size:20px;font-weight:300;color:var(--fg1);line-height:1}
.cal-week-dn.today{background:var(--accent);color:#fff;border-radius:50%;width:32px;height:32px;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:16px}
.cal-week-allday-row{display:grid;grid-template-columns:52px repeat(7,1fr);border-bottom:1px solid var(--bg4);flex-shrink:0;min-height:32px}
.cal-week-allday-cell{border-left:1px solid var(--bg4);padding:2px;display:flex;flex-direction:column;gap:1px}
.cal-week-grid{flex:1;overflow-y:auto}
.cal-week-row{display:grid;grid-template-columns:52px repeat(7,1fr);border-bottom:1px solid var(--bg3);min-height:40px}
.cal-week-cell{border-left:1px solid var(--bg4);padding:2px;display:flex;flex-direction:column;gap:1px}
/* Month sub-view */
.cal-month-view{flex:1;display:flex;flex-direction:column;overflow:hidden;padding:12px 20px}
.cal-month-header{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;margin-bottom:4px}
.cal-month-wh{font-size:11px;color:var(--fg3);font-weight:600;text-align:center;padding:4px 0;text-transform:uppercase}
.cal-month-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;flex:1;overflow-y:auto}
.cal-month-cell{padding:4px;border:1px solid var(--bg4);border-radius:6px;min-height:80px;cursor:pointer;position:relative;overflow:visible}
.cal-month-cell:hover{background:var(--bg2)}
.cal-month-cell.today{border-color:var(--accent)}
.cal-month-cell.focused{background:var(--bg2)}
.cal-month-cell.empty{border-color:transparent;cursor:default}
.cal-month-dn{font-size:12px;font-weight:500;color:var(--fg2);margin-bottom:2px;line-height:1}
.cal-month-cell.today .cal-month-dn{background:var(--accent);color:#fff;border-radius:50%;width:20px;height:20px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700}
/* Event chip (shared) */
.cal-chip{display:flex;flex-direction:column;gap:1px;padding:2px 5px;border-radius:3px;font-size:10px;overflow:hidden;cursor:pointer;margin-bottom:1px}
.cal-chip.compact{font-size:10px;padding:1px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cal-chip-title{font-size:11px;font-weight:500;color:var(--fg1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cal-chip-title-sm{font-size:10px;color:var(--fg1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cal-chip-time{font-size:10px;color:var(--fg3)}
.cal-chip-more{font-size:10px;color:var(--accent);cursor:pointer;padding:1px 4px;font-weight:600}
.cal-chip-more:hover{text-decoration:underline}
.cal-chip-popover{position:absolute;top:100%;left:0;z-index:100;background:var(--bg1);border:1px solid var(--bg4);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.15);padding:10px;min-width:200px;display:flex;flex-direction:column;gap:4px}
.cal-popover-title{font-size:12px;font-weight:600;color:var(--fg1);margin-bottom:6px}
.cal-popover-close{position:absolute;top:6px;right:8px;background:none;border:none;color:var(--fg3);cursor:pointer;font-size:14px}
/* Widget "full view" link */
.cal-full-view-link{font-size:12px;color:var(--accent);text-align:right;padding:4px 0 0;cursor:pointer}
.cal-full-view-link:hover{text-decoration:underline}
.schedule-view-toggle{display:flex;gap:4px;margin-bottom:8px}

/* ── Notes full view (WC6-WC9) ─────────── */
.notes-full-view{display:flex;flex-direction:column;height:100%;overflow:hidden}
.notes-layout{display:grid;grid-template-columns:260px 1fr;height:100%;overflow:hidden}
.notes-sidebar{border-right:1px solid var(--bg4);overflow-y:auto;display:flex;flex-direction:column}
.notes-main{flex:1;overflow:hidden;display:flex;flex-direction:column}
/* List panel */
.notes-list-panel{display:flex;flex-direction:column;height:100%}
.notes-list-header{display:flex;align-items:center;justify-content:space-between;padding:14px 14px 8px;flex-shrink:0}
.notes-list-title{font-size:13px;font-weight:600;color:var(--fg1)}
.notes-list-actions{display:flex;gap:6px}
.notes-new-btn{font-size:12px;padding:4px 10px;border-radius:8px;background:var(--accent);color:#fff;border:none;cursor:pointer;font-weight:600}
.notes-new-btn:hover{opacity:.88}
.notes-templates-btn{font-size:12px;padding:4px 10px;border-radius:8px;background:var(--bg2);color:var(--fg2);border:1px solid var(--bg4);cursor:pointer}
.notes-templates-btn:hover{background:var(--bg3)}
.notes-search-bar{padding:0 12px 8px;flex-shrink:0}
.notes-search-input{width:100%;padding:6px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg1);font-size:12px;box-sizing:border-box}
.notes-search-input:focus{outline:none;border-color:var(--accent)}
/* weaveNotes Phase 7 — capture panel */
.notes-capture-bar{padding:4px 12px 8px}
.notes-capture-toggle{width:100%;padding:6px 10px;border:1px dashed var(--bg4);border-radius:8px;background:transparent;color:var(--fg2);font-size:12px;cursor:pointer}
.notes-capture-toggle:hover{border-color:var(--accent);color:var(--accent)}
.notes-capture-open{border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);padding:8px}
.notes-capture-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
.notes-capture-title{font-size:12px;font-weight:600;color:var(--fg1)}
.notes-capture-close{border:none;background:transparent;color:var(--fg3);font-size:16px;line-height:1;cursor:pointer}
.notes-capture-row{display:flex;gap:6px;margin-bottom:6px}
.notes-capture-jot{flex:1;resize:vertical;padding:6px 8px;border:1px solid var(--bg4);border-radius:6px;background:var(--bg1);color:var(--fg1);font-size:12px;font-family:inherit;box-sizing:border-box}
.notes-capture-url{flex:1;padding:6px 8px;border:1px solid var(--bg4);border-radius:6px;background:var(--bg1);color:var(--fg1);font-size:12px;box-sizing:border-box}
.notes-capture-jot:focus,.notes-capture-url:focus{outline:none;border-color:var(--accent)}
.notes-capture-btn{padding:0 12px;border:none;border-radius:6px;background:var(--accent);color:#fff;font-size:12px;cursor:pointer;white-space:nowrap}
.notes-capture-btn:hover{opacity:.9}
.notes-capture-status{font-size:11px;color:var(--fg3);min-height:14px;margin-top:2px}
/* weaveNotes Phase 8 — workspace panels (history / comments / synced) + Ask box */
.notes-ws-panel{border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);padding:8px;margin:6px 12px}
/* weaveNotes Phase 3 — proactive linking */
.notes-proactive-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:6px 12px;padding:7px 10px;border:1px solid #DCEFE5;border-radius:10px;background:#F4FBF7}
.notes-proactive-label{font-size:12px;font-weight:600;color:#0B7A57;white-space:nowrap}
.notes-proactive-chips{display:flex;gap:6px;flex-wrap:wrap}
.notes-proactive-chip{font-size:12px;padding:3px 9px;border-radius:999px;border:1px solid #9FD8BE;background:#fff;color:#0B7A57;cursor:pointer;font-weight:600}
.notes-proactive-chip:hover{background:#E8F5EE}
.notes-proactive-chip:disabled{opacity:.6;cursor:default}
.notes-proactive-dismiss{margin-left:auto;border:none;background:transparent;color:#9aa7a1;cursor:pointer;font-size:13px;line-height:1}
.notes-suggest-list{display:flex;flex-direction:column;gap:6px}
.notes-suggest-row{display:flex;align-items:center;gap:6px}
.notes-conn-reason{font-size:11px;color:#9aa7a1}
.notes-suggest-link-btn{margin-left:auto;font-size:11px;padding:2px 8px;border-radius:7px;border:1px solid #9FD8BE;background:#fff;color:#0B7A57;cursor:pointer;font-weight:600}
.notes-suggest-link-btn:hover{background:#E8F5EE}
.notes-suggest-link-btn:disabled{opacity:.6;cursor:default}
/* weaveNotes Phase 4 — meeting / voice capture */
.notes-meeting-panel{display:flex;flex-direction:column;gap:12px;min-width:440px;max-width:560px}
.notes-meeting-intro{font-size:13px;line-height:1.5;color:var(--fg2);margin:0}
.notes-meeting-controls{display:flex;align-items:center;gap:12px}
.notes-meeting-record{font-size:14px;font-weight:700;padding:9px 18px;border-radius:999px;border:1px solid #E4B4AE;background:#fff;color:#C0392B;cursor:pointer}
.notes-meeting-record:hover{background:#FBEFEA}
.notes-meeting-record.recording{background:#C0392B;color:#fff;border-color:#C0392B;animation:notes-meeting-pulse 1.2s ease-in-out infinite}
.notes-meeting-record:disabled{opacity:.6;cursor:default}
@keyframes notes-meeting-pulse{0%,100%{box-shadow:0 0 0 0 rgba(192,57,43,.4)}50%{box-shadow:0 0 0 6px rgba(192,57,43,0)}}
.notes-meeting-timer{font-variant-numeric:tabular-nums;font-size:15px;color:var(--fg1);min-width:44px}
.notes-meeting-secondary{font-size:12px;padding:6px 12px;border-radius:8px;border:1px solid var(--bg4);background:var(--bg2);color:var(--fg1);cursor:pointer}
.notes-meeting-secondary:hover{background:var(--bg3)}
.notes-meeting-status{font-size:12px;min-height:16px;color:var(--fg2)}
.notes-meeting-status.busy{color:#0B7A57}
.notes-meeting-status.ok{color:#0B7A57;font-weight:600}
.notes-meeting-status.err{color:#C0392B}
.notes-meeting-paste-wrap{display:flex;flex-direction:column;gap:6px;border-top:1px solid var(--bg4);padding-top:10px}
.notes-meeting-paste{width:100%;box-sizing:border-box;font-size:13px;padding:8px;border-radius:8px;border:1px solid var(--bg4);background:var(--bg1);color:var(--fg1);resize:vertical}
.notes-meeting-flash{background:#FEF6D8 !important;border-radius:6px;transition:background .4s ease}
/* weaveNotes Phase 5 — background memory ("second brain") */
.notes-memory-strip{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:6px 12px;padding:7px 10px;border:1px solid #D8D0EC;border-radius:10px;background:#F6F3FC}
.notes-memory-strip-label{font-size:12px;font-weight:600;color:#6A4CA6;white-space:nowrap}
.notes-memory-strip-items{display:flex;gap:6px;flex-wrap:wrap}
.notes-memory-chip{font-size:12px;padding:3px 9px;border-radius:999px;border:1px solid #C9BCE6;background:#fff;color:#5A3E96}
.notes-memory-strip-dismiss{margin-left:auto;border:none;background:transparent;color:#9aa7a1;cursor:pointer;font-size:13px;line-height:1}
.notes-memory-panel{display:flex;flex-direction:column;gap:10px;min-width:460px;max-width:600px}
.notes-memory-intro{font-size:13px;line-height:1.5;color:var(--fg2);margin:0}
.notes-memory-search{width:100%;box-sizing:border-box;font-size:13px;padding:8px 12px;border-radius:8px;border:1px solid var(--bg4);background:var(--bg1);color:var(--fg1)}
.notes-memory-status{font-size:12px;color:var(--fg2);min-height:15px}
.notes-memory-list{display:flex;flex-direction:column;gap:6px;max-height:420px;overflow-y:auto}
.notes-memory-row{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2)}
.notes-memory-row-main{flex:1;display:flex;flex-direction:column;gap:2px}
.notes-memory-row-text{font-size:13px;color:var(--fg1);line-height:1.4}
.notes-memory-row-meta{font-size:11px;color:#9aa7a1}
.notes-memory-open{border:none;background:transparent;color:#6A4CA6;cursor:pointer;font-size:13px;align-self:flex-start}
.notes-memory-forget{border:none;background:transparent;color:#C0392B;cursor:pointer;font-size:13px}
.notes-memory-forget:disabled{opacity:.4;cursor:default}
.notes-memory-empty{font-size:13px;color:var(--fg2);padding:12px;text-align:center}
.notes-ws-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
.notes-ws-title{font-size:12px;font-weight:600;color:var(--fg1)}
.notes-ws-action{padding:3px 10px;border:none;border-radius:6px;background:var(--accent);color:#fff;font-size:11px;cursor:pointer;white-space:nowrap}
.notes-ws-action:hover{opacity:.9}
.notes-ws-link{border:none;background:transparent;color:var(--accent);font-size:11px;cursor:pointer;padding:2px 4px}
.notes-ws-loading,.notes-ws-empty{font-size:11px;color:var(--fg3);padding:6px 2px}
.notes-ws-list{display:flex;flex-direction:column;gap:6px;max-height:280px;overflow-y:auto}
.notes-ws-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 6px;border:1px solid var(--bg4);border-radius:6px}
.notes-ws-row-main{display:flex;flex-direction:column}
.notes-ws-row-title{font-size:12px;color:var(--fg1)}
.notes-ws-row-meta{font-size:10px;color:var(--fg3)}
.notes-ws-restore{padding:2px 8px;border:1px solid var(--bg4);border-radius:6px;background:var(--bg1);color:var(--fg2);font-size:11px;cursor:pointer}
.notes-ws-restore:hover{border-color:var(--accent);color:var(--accent)}
.notes-ws-comment-new,.notes-ws-synced-new{display:flex;gap:6px;margin-bottom:6px;align-items:flex-start}
.notes-ws-comment-input{flex:1;resize:vertical;padding:5px 8px;border:1px solid var(--bg4);border-radius:6px;background:var(--bg1);color:var(--fg1);font-size:12px;font-family:inherit;box-sizing:border-box}
.notes-ws-thread{border:1px solid var(--bg4);border-radius:6px;padding:6px}
.notes-ws-comment{padding:3px 0}
.notes-ws-comment.reply{margin-left:14px;border-left:2px solid var(--bg4);padding-left:8px}
.notes-ws-comment.resolved{opacity:.6}
.notes-ws-comment-head{display:flex;align-items:center;gap:8px;font-size:10px;color:var(--fg3)}
.notes-ws-comment-author{font-weight:600;color:var(--fg2)}
.notes-ws-comment-body{font-size:12px;color:var(--fg1)}
.notes-ws-resolved-badge{background:var(--bg4);color:var(--fg2);border-radius:4px;padding:0 4px;font-size:9px}
.notes-ws-reply{margin-top:4px}
.notes-ws-reply-input{width:100%;padding:4px 8px;border:1px solid var(--bg4);border-radius:6px;background:var(--bg1);color:var(--fg1);font-size:11px;box-sizing:border-box}
.notes-ws-select{flex:1;padding:5px 8px;border:1px solid var(--bg4);border-radius:6px;background:var(--bg1);color:var(--fg1);font-size:12px}
.notes-ws-synced{border:1px solid var(--bg4);border-radius:6px;padding:6px;background:var(--bg1)}
.notes-ws-synced.unavailable{opacity:.6}
.notes-ws-synced-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:3px}
.notes-ws-synced-src{font-size:11px;font-weight:600;color:var(--accent)}
.notes-ws-synced-body{font-size:12px;color:var(--fg1);white-space:pre-wrap}
.notes-ws-ask{padding:4px 12px 8px}
.notes-ws-ask-bar{display:flex;gap:6px;align-items:center}
.notes-ws-ask-input{flex:1;padding:6px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg1);font-size:12px;box-sizing:border-box}
.notes-ws-ask-input:focus{outline:none;border-color:var(--accent)}
.notes-ws-ask-results{margin-top:6px;display:flex;flex-direction:column;gap:6px;max-height:300px;overflow-y:auto}
.notes-ws-ask-label{font-size:11px;color:var(--fg3)}
.notes-ws-ask-hit{border:1px solid var(--bg4);border-radius:6px;padding:6px;cursor:pointer}
.notes-ws-ask-hit:hover{border-color:var(--accent)}
.notes-ws-ask-hit-head{display:flex;align-items:center;gap:6px;margin-bottom:2px}
.notes-ws-ask-n{font-weight:700;color:var(--accent);font-size:11px}
.notes-ws-ask-kind{font-size:9px;text-transform:uppercase;background:var(--bg4);color:var(--fg2);border-radius:4px;padding:0 4px}
.notes-ws-ask-title{font-size:12px;font-weight:600;color:var(--fg1)}
.notes-ws-ask-snippet{font-size:11px;color:var(--fg2);line-height:1.4}
/* Phase 2: cited "Ask your workspace" answer + verified citations */
.notes-ws-ask-answer{font-size:14px;line-height:1.7;color:var(--fg1);margin:4px 0 12px;white-space:pre-wrap}
.notes-ws-cite-chip{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;margin:0 1px;padding:0 4px;font-size:10px;font-weight:700;color:#0B7A57;background:#E8F5EE;border:1px solid #BfE6D4;border-radius:999px;cursor:pointer;vertical-align:super;line-height:1}
.notes-ws-cite-chip:hover{background:#0B7A57;color:#fff}
.notes-ws-cite-chip.unmatched{color:var(--fg2);background:var(--bg4);border-color:var(--bg4);cursor:default}
.notes-ws-cite-label{font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--fg2);margin:4px 0 6px}
.notes-ws-citation{display:flex;align-items:baseline;gap:6px;border:1px solid var(--bg4);border-left:3px solid #0B7A57;border-radius:6px;padding:6px 8px;margin-bottom:5px;cursor:pointer}
.notes-ws-citation:hover{border-color:#0B7A57;background:#F4FBF7}
.notes-ws-cite-quote{font-size:12px;color:var(--fg1);font-style:italic;flex:1}
.notes-ws-cite-src{font-size:11px;color:var(--fg2);white-space:nowrap}
/* The cited line, highlighted in the source note when a citation is clicked (CSS Custom Highlight API) */
::highlight(gw-cite){background:#FCEBA4;color:inherit;border-radius:2px}

/* ════════════════ geneWeave Notes — 3-column design shell (design handoff) ════════════════ */
.gw-notes{height:100%}
.gw-shell{display:grid;grid-template-columns:248px minmax(0,1fr) 300px;height:100%;overflow:hidden;background:var(--canvas)}
/* 2-column shell: notebooks rail + canvas; the assistant floats over the canvas (bottom-right) */
.gw-shell-2col{grid-template-columns:248px minmax(0,1fr);position:relative}
/* Rail collapsed → the canvas takes the whole width; a floating tab re-opens the rail. */
.gw-shell-2col.rail-collapsed{grid-template-columns:minmax(0,1fr)}
.gw-rail-expand{position:absolute;top:11px;left:14px;z-index:60;width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--hairline);border-radius:9px;background:var(--surface);color:var(--fg2);font-size:15px;cursor:pointer;box-shadow:0 2px 8px rgba(20,32,27,.06)}
.gw-rail-expand:hover{background:var(--bg3);color:var(--fg)}
/* When collapsed, shift the note top-bar's content right so it clears the floating expand tab. */
.gw-shell-2col.rail-collapsed .gw-topbar{padding-left:56px}
/* floating assistant dock */
.gw-assistant-dock{position:absolute;right:26px;bottom:26px;z-index:45}
.gw-assistant-bubble{width:60px;height:60px;border-radius:50%;background:var(--surface);border:1px solid var(--mint-deep);box-shadow:0 10px 30px rgba(20,32,27,.18);cursor:pointer;display:flex;align-items:center;justify-content:center;position:relative;animation:gw-bubble-pulse 3.4s ease-in-out infinite}
.gw-assistant-bubble-mark{display:inline-flex}
.gw-assistant-bubble-dot{position:absolute;top:6px;right:6px;width:11px;height:11px;border-radius:50%;background:var(--accent);border:2px solid var(--surface)}
@keyframes gw-bubble-pulse{0%,100%{box-shadow:0 10px 30px rgba(20,32,27,.18)}50%{box-shadow:0 10px 30px rgba(20,32,27,.18),0 0 0 8px rgba(14,154,110,.08)}}
.gw-assistant-panel{width:352px;height:580px;max-height:calc(100vh - 52px);background:var(--surface);border:1px solid var(--hairline);border-radius:20px;box-shadow:0 18px 50px rgba(20,32,27,.22);display:flex;flex-direction:column;overflow:hidden;position:relative}
.gw-assistant-panel .gw-rail{border-left:none;border-radius:20px;height:100%;background:transparent}
.gw-assistant-min{position:absolute;top:12px;right:12px;z-index:5;width:30px;height:30px;border-radius:8px;border:none;background:transparent;color:var(--fg3);cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
.gw-assistant-min:hover{background:var(--bg3);color:var(--fg2)}
@media(prefers-reduced-motion:reduce){.gw-assistant-bubble{animation:none}}
/* on phones the panel fills most of the screen */
@media(max-width:899.98px){.gw-assistant-dock{right:16px;bottom:16px}.gw-assistant-panel{width:calc(100vw - 32px);max-width:352px;height:min(70vh,560px)}}
.gw-scroll::-webkit-scrollbar{width:10px}
.gw-scroll::-webkit-scrollbar-thumb{background:var(--bg4);border-radius:999px;border:3px solid transparent;background-clip:padding-box}
/* — full-bleed: Notes takes the whole viewport (its rail is the primary nav) — */
.app-fullbleed{display:block;height:100vh;width:100vw;overflow:hidden}
.app-fullbleed .gw-notes,.app-fullbleed .notes-full-view{height:100vh}
/* — left notebooks rail (design handoff) — */
.gw-leftrail{background:var(--surface);border-right:1px solid var(--hairline);overflow:hidden;display:flex;flex-direction:column;min-width:0;padding:16px 12px}
.gw-leftrail-head{display:flex;align-items:center;gap:6px}
.gw-brand{display:flex;align-items:center;gap:10px;padding:6px 8px 16px;background:none;border:none;cursor:pointer;flex:1;min-width:0}
.gw-brand:hover{opacity:.85}
.gw-rail-collapse{flex:none;margin-bottom:10px;width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--bg4);border-radius:7px;background:var(--bg3);color:var(--fg2);font-size:13px;cursor:pointer}
.gw-rail-collapse:hover{background:var(--bg);color:var(--fg)}
.gw-brand-mark{display:inline-flex}
.gw-brand-word{font-family:var(--font-display);font-size:15px;font-weight:700;letter-spacing:-0.02em}
.gw-search{display:flex;align-items:center;gap:8px;background:var(--canvas);border:1px solid var(--hairline);border-radius:10px;padding:8px 11px;margin-bottom:18px}
.gw-search-ic{display:inline-flex;color:var(--fg3)}
.gw-search-input{flex:1;border:none;background:transparent;outline:none;font-size:13px;color:var(--ink)}
.gw-search-input::placeholder{color:var(--fg3)}
.gw-kbd{font-family:var(--mono);font-size:10px;color:var(--fg3);border:1px solid var(--hairline);border-radius:5px;padding:2px 5px}
.gw-tree{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:2px}
.gw-tree-label-row{font-family:var(--mono);font-size:10px;letter-spacing:.1em;color:var(--fg3);padding:8px 10px 6px}
.gw-tree-row{display:flex;align-items:center;gap:7px;padding:7px 10px;font-size:13px;color:var(--fg2);border-radius:9px;cursor:pointer}
/* notebook folder tree: expand/collapse caret + nested (indented) sub-notes */
.gw-tree-caret{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:none;border:none;background:none;color:var(--fg3);cursor:pointer;padding:0;transition:transform .15s ease}
.gw-tree-caret.open{transform:rotate(90deg)}
.gw-tree-caret-none{visibility:hidden;cursor:default}
.gw-tree-nest{display:flex;flex-direction:column;gap:2px;margin-left:17px;padding-left:9px;border-left:1px solid var(--hairline)}
.gw-tree-row:hover{background:var(--bg3)}
.gw-tree-row.active{color:var(--accent2);background:var(--mint);font-weight:500}
.gw-tree-icon{display:inline-flex;color:var(--fg3)}
.gw-tree-row.active .gw-tree-icon{color:var(--accent)}
.gw-tree-emoji{font-size:13px;line-height:1}
.gw-tree-label{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gw-tree-fav{border:none;background:none;color:var(--fg3);cursor:pointer;font-size:12px;opacity:0}
.gw-tree-row:hover .gw-tree-fav,.gw-tree-fav.on{opacity:1}
.gw-tree-add{border:none;background:none;color:var(--fg3);cursor:pointer;font-size:15px;line-height:1;opacity:0;padding:0 2px}
.gw-tree-row:hover .gw-tree-add{opacity:1}
.gw-tree-add:hover{color:var(--accent2)}
.gw-tree-fav.on{color:var(--amber)}
.gw-tree-empty,.gw-tree-loading{font-size:12px;color:var(--fg3);padding:8px 10px}
.gw-newnote{display:flex;align-items:center;gap:9px;font-family:var(--font);font-size:13px;font-weight:600;color:var(--accent2);background:var(--surface);border:1px solid var(--mint-deep);border-radius:10px;padding:10px 12px;cursor:pointer;margin-top:8px}
.gw-newnote:hover{background:var(--mint)}
.gw-newnote-plus{font-size:15px;line-height:1}
.gw-newnote-tmpl{margin-left:auto;font-size:11px;color:var(--fg3);font-weight:400}
.gw-newnote-tmpl:hover{color:var(--accent2)}
/* weaveNotes Phase 6 — the Archived shortcut under the New-note button */
.gw-newnote-archived{display:flex;align-items:center;gap:7px;width:100%;font-family:var(--font);font-size:12px;font-weight:500;color:var(--fg3);background:transparent;border:none;border-radius:8px;padding:7px 12px;cursor:pointer;margin-top:2px}
.gw-newnote-archived:hover{color:var(--accent2);background:var(--surface)}
.gw-newnote-archived-ic{display:inline-flex;opacity:.8}
/* weaveNotes Phase 8 — desktop: quick-capture overlay + offline banner */
.gw-qc-overlay{position:fixed;inset:0;background:rgba(15,23,42,.38);display:flex;align-items:flex-start;justify-content:center;padding-top:14vh;z-index:1000}
.gw-qc-card{width:min(560px,92vw);background:var(--surface,#fff);border:1px solid var(--bg4,#e5e7eb);border-radius:14px;box-shadow:0 16px 48px rgba(0,0,0,.22);overflow:hidden}
.gw-qc-head{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--bg4,#eef0f2)}
.gw-qc-title{font-weight:700;font-size:14px;color:var(--fg1,#111827)}
.gw-qc-x{border:none;background:transparent;font-size:20px;line-height:1;color:var(--fg3,#9ca3af);cursor:pointer}
.gw-qc-input{width:100%;border:none;outline:none;resize:none;padding:16px;font-size:15px;line-height:1.5;font-family:var(--font,inherit);color:var(--fg1,#111827);background:transparent}
.gw-qc-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 16px;border-top:1px solid var(--bg4,#eef0f2);background:var(--bg2,#fafafa)}
.gw-qc-hint{font-size:11px;color:var(--fg3,#9ca3af)}
.gw-qc-actions{display:flex;align-items:center;gap:10px}
.gw-qc-status{font-size:12px;color:var(--fg3,#9ca3af)}
.gw-qc-save{background:var(--accent2,#0f766e);color:#fff;border:none;border-radius:8px;padding:7px 16px;font-size:13px;font-weight:600;cursor:pointer}
.gw-qc-save:hover{filter:brightness(1.05)}
.gw-notes-offline{padding:7px 16px;background:#FEF3C7;color:#92400E;font-size:12px;font-weight:600;text-align:center}
/* weaveNotes Phase 10 — export menu */
.gw-export-menu{display:flex;flex-direction:column;gap:8px;padding:4px 2px}
.gw-export-sub{font-size:12px;color:var(--fg3,#9ca3af);margin-bottom:2px}
.gw-export-opt{display:flex;flex-direction:column;align-items:flex-start;gap:2px;text-align:left;width:100%;padding:10px 12px;border:1px solid var(--bg4,#e5e7eb);border-radius:10px;background:var(--bg2,#fafafa);cursor:pointer}
.gw-export-opt:hover{border-color:var(--accent2,#0f766e);background:var(--surface,#fff)}
.gw-export-opt-label{font-size:13px;font-weight:600;color:var(--fg1,#111827)}
.gw-export-opt-hint{font-size:11px;color:var(--fg3,#9ca3af)}
/* weaveNotes — the INLINE AI-edit diff card (matches GeneWeave Notes.dc.html track-changes) */
.notes-ai-panel{display:flex;flex-direction:column;gap:12px}
.notes-diff{border:1px solid #DCEFE5;border-radius:14px;overflow:hidden;background:#fff;box-shadow:0 1px 2px rgba(20,32,27,.04)}
.notes-diff-head{display:flex;align-items:center;gap:8px;padding:9px 14px;border-bottom:1px solid #F0F2F1;background:#F4FBF7}
.notes-diff-mark{display:inline-flex;align-items:center}
.notes-diff-title{font-size:12px;font-weight:600;color:#0B7A57}
.notes-diff-by{font-size:11px;color:#9aa7a1;margin-left:auto}
.notes-diff-body{padding:14px;display:flex;flex-direction:column;gap:8px}
.notes-diff-old{font-size:15px;line-height:1.7;color:#9c6b5c;background:#FBEFEA;border-radius:8px;padding:8px 12px;text-decoration:line-through;white-space:pre-wrap}
.notes-diff-new{font-size:15px;line-height:1.7;color:#14201B;background:#E8F5EE;border-radius:8px;padding:8px 12px;white-space:pre-wrap}
.notes-diff-actions{display:flex;gap:8px;padding-top:2px}
.notes-diff-accept{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:600;color:#fff;background:#0E9A6E;border:none;border-radius:999px;padding:7px 15px;cursor:pointer}
.notes-diff-accept:hover{background:#0B7A57}
.notes-diff-reject{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:600;color:#5E6E67;background:#fff;border:1px solid #E7ECEA;border-radius:999px;padding:7px 15px;cursor:pointer}
.notes-diff-reject:hover{background:#F6F8F7}
.notes-diff-resolved{font-size:15px;line-height:1.7;color:#14201B;white-space:pre-wrap}
.notes-diff-badge{font-size:11px;border-radius:999px;padding:2px 8px;white-space:nowrap;margin-left:6px;display:inline-block}
.notes-diff-badge.accepted{color:#0B7A57;background:#E8F5EE}
.notes-diff-badge.rejected{color:#9aa7a1;background:#F0F2F1}
/* — dropdown menus (Insert / overflow) + modal — */
.gw-menu-anchor{position:relative;display:inline-flex}
.gw-menu{position:absolute;top:38px;z-index:300;background:var(--surface);border:1px solid var(--hairline);border-radius:12px;box-shadow:var(--shadow-pop);padding:6px;min-width:210px;display:flex;flex-direction:column;gap:2px}
.gw-menu-right{right:0}.gw-menu-left{left:0}
.gw-menu-item{text-align:left;font-size:13px;color:var(--fg);background:transparent;border:none;border-radius:8px;padding:8px 10px;cursor:pointer}
.gw-menu-item:hover{background:var(--mint)}
.gw-menu-item.danger{color:var(--danger-zone-fg)}
.gw-menu-item.danger:hover{background:var(--danger-zone-bg)}
/* rich Insert popover (design): rounded card, mono section headers, a CAPTURE card grid, item icons */
.gw-menu-rich{border-radius:16px;box-shadow:0 16px 44px rgba(20,32,27,.18);padding:10px;min-width:300px;max-height:min(70vh,560px);overflow-y:auto}
.gw-menu-section{font-family:var(--mono);font-size:10px;letter-spacing:.1em;color:var(--fg3);padding:10px 8px 6px}
.gw-menu-rich .gw-menu-section:first-child{color:var(--accent);padding-top:4px}
.gw-menu-cards{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:2px}
.gw-menu-card{display:flex;align-items:center;gap:9px;text-align:left;padding:9px 10px;border-radius:11px;border:1px solid var(--mint-deep);background:var(--mint-wash);cursor:pointer}
.gw-menu-card:hover{background:var(--mint)}
.gw-menu-card-ic{width:28px;height:28px;border-radius:8px;background:var(--surface);display:inline-flex;align-items:center;justify-content:center;flex:none;font-size:14px;color:var(--accent2)}
.gw-menu-card-ic svg{width:17px;height:17px;display:block}
.gw-menu-card-tx{min-width:0;line-height:1.2;display:flex;flex-direction:column}
.gw-menu-card-label{font-size:12.5px;font-weight:600;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gw-menu-card-sub{font-size:10.5px;color:var(--fg2);white-space:nowrap}
.gw-menu-rich .gw-menu-item{display:flex;align-items:center;gap:11px}
.gw-menu-item-ic{width:22px;display:inline-flex;align-items:center;justify-content:center;flex:none;color:var(--fg3)}
.gw-menu-item-ic svg{width:16px;height:16px;display:block}
.gw-menu-item:hover .gw-menu-item-ic{color:var(--accent2)}
.gw-menu-item.danger .gw-menu-item-ic{color:var(--danger-zone-fg)}
.gw-modal-overlay{position:fixed;inset:0;z-index:100;background:rgba(20,32,27,.28);display:flex;align-items:flex-start;justify-content:center;padding-top:12vh}
.gw-modal{background:var(--surface);border:1px solid var(--hairline);border-radius:16px;box-shadow:var(--shadow-pop);width:520px;max-width:90vw;padding:16px}
.gw-modal-head{display:flex;align-items:center;justify-content:space-between;font-family:var(--font-display);font-weight:700;font-size:15px;margin-bottom:10px}
.gw-modal-x{border:none;background:none;font-size:20px;color:var(--fg3);cursor:pointer;line-height:1}
/* — centre canvas — */
.gw-canvas{display:flex;flex-direction:column;min-width:0;overflow:hidden;background:var(--surface)}
.gw-canvas.creative{background:var(--paper)}
.gw-topbar{position:relative;z-index:50;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:13px 28px;border-bottom:1px solid var(--hairline);background:color-mix(in srgb,var(--surface) 70%,transparent);backdrop-filter:blur(6px);flex:none}
.gw-breadcrumb{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--fg3);min-width:0}
.gw-breadcrumb-sep{color:var(--bg4)}
.gw-breadcrumb-cur{color:var(--ink);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gw-topbar-right{display:flex;align-items:center;gap:12px;flex:none}
.gw-presence{display:flex;align-items:center}
.gw-avatar{width:26px;height:26px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;border:2px solid var(--surface);font-size:11px;font-weight:600}
.gw-avatar-you{background:var(--ink);color:var(--surface)}
.gw-avatar-ai{background:var(--mint);margin-left:-8px}
.gw-theme-toggle{display:flex;background:var(--bg3);border-radius:999px;padding:3px}
.gw-theme-tab{font-size:12px;font-weight:600;border:none;border-radius:999px;padding:6px 14px;cursor:pointer;background:transparent;color:var(--fg2);transition:all .15s}
.gw-theme-tab.active{background:var(--surface);color:var(--accent2);box-shadow:0 1px 2px rgba(0,0,0,.08)}
/* account avatar in the notes top bar — the way back to profile/settings from the full-bleed Notes app */
.gw-account-avatar{width:32px;height:32px;flex:none;border-radius:50%;background:var(--solid);color:var(--solid-contrast);border:none;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;cursor:pointer}
.gw-account-avatar:hover{box-shadow:0 0 0 2px var(--mint-deep)}
.gw-btn-emerald{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:600;color:#fff;background:var(--accent);border:none;border-radius:999px;padding:8px 16px;cursor:pointer}
.gw-btn-emerald:hover{background:var(--accent2)}
.gw-plus{font-size:14px;line-height:1}
.gw-overflow{position:relative}
.gw-icon-btn{width:32px;height:32px;border-radius:8px;border:1px solid var(--hairline);background:var(--surface);color:var(--fg2);cursor:pointer;font-size:16px;line-height:1}
.gw-icon-btn:hover{border-color:var(--accent);color:var(--accent)}
.gw-overflow-menu{position:absolute;right:0;top:38px;z-index:30;background:var(--surface);border:1px solid var(--hairline);border-radius:12px;box-shadow:var(--shadow-pop);padding:6px;min-width:200px;display:flex;flex-direction:column;gap:2px}
.gw-overflow-item{text-align:left;font-size:13px;color:var(--fg);background:transparent;border:none;border-radius:8px;padding:8px 10px;cursor:pointer}
.gw-overflow-item:hover{background:var(--mint)}
.gw-overflow-item.danger{color:var(--danger-zone-fg)}
.gw-overflow-item.danger:hover{background:var(--danger-zone-bg)}
/* — tool strip — */
.gw-toolstrip{display:flex;align-items:center;gap:6px;padding:9px 28px;border-bottom:1px solid var(--hairline);flex:none}
.gw-tool-group{display:flex;align-items:center;gap:2px;padding-right:10px;margin-right:4px;border-right:1px solid var(--hairline)}
.gw-tool-group.gw-highlighters{gap:6px}
.gw-tool{width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;border-radius:7px;border:none;background:transparent;color:var(--fg2);cursor:pointer;font-size:14px}
.gw-tool:hover{background:var(--bg3)}
.gw-tool-b{font-weight:700}.gw-tool-i{font-style:italic;font-family:Georgia,serif}.gw-tool-u{text-decoration:underline}.gw-tool-s{text-decoration:line-through}
/* block-type dropdown + text-colour menu in the notes toolbar */
.gw-block-btn{width:auto;gap:5px;padding:0 8px;font-size:13px;color:var(--fg2)}
.gw-block-caret{display:inline-flex}
.gw-block-menu{min-width:184px}
.gw-color-menu{display:flex;gap:8px;padding:10px;min-width:auto}
.gw-color-swatch{width:22px;height:22px;border-radius:50%;border:1px solid var(--hairline);cursor:pointer;padding:0}
.gw-color-swatch:hover{transform:scale(1.1)}
.gw-hl{width:18px;height:18px;border-radius:50%;cursor:pointer;flex:none;padding:0;border:none;box-shadow:inset 0 0 0 1px rgba(20,32,27,.10)}
.gw-hl.active{box-shadow:0 0 0 2px var(--surface),0 0 0 3px var(--accent)}
/* each highlighter swatch shows its own colour (design tokens) */
.gw-hl-amber{background:var(--hl-amber)}
.gw-hl-pink{background:var(--hl-pink)}
.gw-hl-teal{background:var(--hl-teal)}
.gw-hl-blue{background:var(--hl-blue)}
/* columns 1/2/3 segmented control (design's board layout) — pushed to the right of the tool strip */
.gw-cols-seg{display:flex;align-items:center;gap:2px;background:var(--bg3);border-radius:8px;padding:2px;margin-left:auto}
.gw-cols-btn{width:28px;height:26px;display:inline-flex;align-items:center;justify-content:center;border:none;background:transparent;color:var(--fg3);border-radius:6px;cursor:pointer;padding:0}
.gw-cols-btn:hover{color:var(--fg2)}
.gw-cols-btn.active{background:var(--surface);color:var(--accent2);box-shadow:0 1px 2px rgba(0,0,0,.08)}
.gw-ask-ai{display:inline-flex;align-items:center;gap:7px;font-size:13px;font-weight:600;color:var(--accent2);background:var(--mint);border:1px solid var(--mint-deep);border-radius:8px;padding:6px 12px;cursor:pointer;margin-left:10px}
.gw-ask-ai:hover{background:var(--mint-deep)}
/* apply the column layout to the editor body only (title + meta stay full width) */
.gw-canvas[data-cols="2"] .notes-editor-mount [contenteditable]{column-count:2;column-gap:36px}
.gw-canvas[data-cols="3"] .notes-editor-mount [contenteditable]{column-count:3;column-gap:28px}
.gw-canvas[data-cols="2"] .notes-editor-mount [contenteditable] > *,
.gw-canvas[data-cols="3"] .notes-editor-mount [contenteditable] > *{break-inside:avoid}
.gw-canvas[data-cols="2"] .gw-page{max-width:min(1360px,100%)}
.gw-canvas[data-cols="3"] .gw-page{max-width:min(1680px,100%)}
.gw-ask-mark{display:inline-flex}
/* — the page — */
.gw-page-scroll{flex:1;overflow-y:auto;padding:48px 40px 120px}
/* The note's reading column. 720px is the classic "ideal measure" (~66 chars) but wastes most of a wide
   screen; we use a more generous 960px so notes fill more real estate while staying readable, and let the
   2/3-column control fill the screen fully. width:100% keeps it filling on smaller/collapsed-rail layouts. */
.gw-page{max-width:min(960px,100%);width:100%;margin:0 auto;display:flex;flex-direction:column;gap:18px;position:relative}
.gw-page-title{display:flex;align-items:center;gap:12px}
.gw-page-title .notes-editor-icon{font-size:30px;cursor:pointer;line-height:1}
.gw-page-title .notes-title-input{flex:1;font-family:var(--font-display);font-size:34px;font-weight:800;letter-spacing:-0.025em;line-height:1.15;color:var(--ink);border:none;background:transparent;outline:none;padding:0}
.gw-canvas.creative .gw-page-title .notes-title-input{font-family:var(--font-hand);font-size:46px;font-weight:700;letter-spacing:0}
.gw-page-meta{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--fg3);margin-top:-6px}
.gw-meta-mono{font-family:var(--mono)}
.gw-ai-here{display:inline-flex;align-items:center;gap:5px}
.gw-ai-dot{width:6px;height:6px;border-radius:50%;background:var(--accent)}
.gw-extract-result{font-size:12px;color:var(--accent2);background:var(--mint);border-radius:8px;padding:6px 10px;align-self:flex-start}
.gw-canvas .notes-editor-mount{flex:none;padding:0}
.gw-canvas .notes-editor-mount [contenteditable]{font-size:16px;line-height:1.75;color:var(--ink)}
/* — right Assistant rail — */
.gw-rail{background:var(--surface);border-left:1px solid var(--hairline);display:flex;flex-direction:column;min-width:0;overflow:hidden}
.gw-rail-tabs{display:flex;gap:4px;padding:14px 16px 0}
.gw-rail-tab{font-size:13px;color:var(--fg3);background:none;border:none;padding:8px 12px;cursor:pointer;border-bottom:2px solid transparent}
.gw-rail-tab.active{color:var(--accent2);font-weight:600;border-bottom-color:var(--accent)}
.gw-rail-divider{height:1px;background:var(--hairline)}
.gw-rail-body{flex:1;overflow-y:auto;padding:16px}
.gw-rail-empty{display:flex;flex-direction:column;gap:12px;align-items:flex-start;font-size:13px;color:var(--fg2);line-height:1.6;padding:8px 4px}
.gw-rail-empty-mark{opacity:.8}
.gw-assistant-body{display:flex;flex-direction:column;gap:14px}
.gw-outline-list{display:flex;flex-direction:column;gap:2px}
.gw-outline-item{text-align:left;font-size:13px;color:var(--fg2);background:none;border:none;border-radius:7px;padding:6px 8px;cursor:pointer}
.gw-outline-item:hover{background:var(--bg3);color:var(--ink)}
.gw-outline-item.lvl2{padding-left:18px}.gw-outline-item.lvl3{padding-left:30px;font-size:12px}
/* — composer — */
.gw-composer{padding:14px 16px;border-top:1px solid var(--hairline)}
.gw-composer-pill{display:flex;align-items:center;gap:10px;background:var(--canvas);border:1px solid var(--hairline);border-radius:14px;padding:9px 12px}
.gw-composer-input{flex:1;border:none;background:transparent;outline:none;font-size:13px;color:var(--ink)}
.gw-composer-send{width:30px;height:30px;border-radius:50%;background:var(--accent);border:none;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex:none}
.gw-composer-send svg path{stroke:#fff}
/* AI inline diff (Phase 3 suggestions) — design diff colours */
.notes-suggestion-removed,.gw-diff-del{background:var(--diff-del-bg);color:var(--diff-del-fg);text-decoration:line-through;border-radius:8px;padding:8px 12px}
.notes-suggestion-added,.gw-diff-add{background:var(--diff-add-bg);color:var(--diff-add-fg);border-radius:8px;padding:8px 12px}
/* left-rail header: let the action buttons wrap inside the narrow 248px rail */
.gw-left-rail .notes-list-header{flex-wrap:wrap;gap:6px;padding:8px 14px}
.gw-left-rail .notes-list-actions{flex-wrap:wrap}
.gw-left-rail .notes-ws-ask-bar{flex-wrap:wrap}
.gw-left-rail .notes-databases-btn{margin-top:4px}
.gw-left-rail .notes-list-title{font-family:var(--font-display);font-weight:700;font-size:13px;color:var(--fg2)}
/* right-rail Assistant — design: a mint AI greeting bubble, then full-width suggestion buttons */
.gw-ai-msg{display:flex;gap:9px;align-items:flex-start}
.gw-ai-msg-avatar{flex:none;width:26px;height:26px;border-radius:50%;background:var(--mint);display:inline-flex;align-items:center;justify-content:center}
.gw-ai-msg-bubble{background:var(--mint);color:var(--ink);font-size:13px;line-height:1.6;padding:11px 14px;border-radius:14px;border-top-left-radius:5px}
.gw-assistant-body .notes-ai-toolbar{display:flex;flex-direction:column;align-items:stretch;gap:8px;padding-left:35px}
.gw-assistant-body .notes-ai-label{font-size:11px;font-weight:600;color:var(--fg3);text-transform:uppercase;letter-spacing:.04em}
.gw-assistant-body .notes-ai-btn{font-size:13px;color:var(--accent2);background:var(--surface);border:1px solid var(--mint-deep);border-radius:10px;padding:9px 12px;cursor:pointer;text-align:left}
.gw-assistant-body .notes-ai-btn:hover{background:var(--mint)}
.gw-assistant-body .notes-ai-status{padding-left:35px;font-size:12px;color:var(--fg3)}
/* the co-edit "updated" nudge: a floating bottom-left pill (only shown for real collaborators) */
.gw-canvas>.notes-coedit-refresh{position:absolute;left:28px;bottom:18px;z-index:15;font-size:12px;font-weight:600;color:var(--accent2);background:var(--mint);border:1px solid var(--mint-deep);border-radius:999px;padding:6px 13px;cursor:pointer;box-shadow:var(--shadow-soft)}
.gw-canvas{position:relative}
/* editor content — highlight mark. An UNCOLOURED highlight follows the theme treatment
   (Pro soft fill ↔ Creative underline gradient, spec §10.6); a COLOURED highlight (a swatch)
   carries its own inline background-color so the four-colour highlighter shows through. */
.gw-canvas .notes-editor-mount mark:not([data-color]){background:#FCEFCF;border-radius:3px;padding:0 3px;color:inherit}
.gw-canvas.creative .notes-editor-mount mark:not([data-color]){background:linear-gradient(transparent 62%, var(--hl-amber) 62%);border-radius:0;padding:0 1px}

/* weaveNotes Phase 1 — creative blocks. Agency colour: an AI-authored callout/sticker
   wears mint (data-author="ai"); a human's stays neutral (Phase 0 contract). */
.gw-canvas .notes-editor-mount .gw-callout{display:block;margin:10px 0;padding:12px 14px 12px 16px;border-radius:12px;border-left:4px solid var(--muted);background:var(--canvas)}
.gw-canvas .notes-editor-mount .gw-callout[data-tone="tip"]{border-left-color:var(--accent);background:var(--mint)}
.gw-canvas .notes-editor-mount .gw-callout[data-tone="success"]{border-left-color:var(--accent);background:var(--mint)}
.gw-canvas .notes-editor-mount .gw-callout[data-tone="warning"]{border-left-color:#D98A3D;background:#FCF3E6}
.gw-canvas .notes-editor-mount .gw-callout[data-tone="danger"]{border-left-color:var(--coral,#D85A30);background:#FCF7F2}
.gw-canvas .notes-editor-mount .gw-callout[data-author="ai"]{background:var(--mint);border-left-color:var(--accent)}
.gw-canvas .notes-editor-mount .gw-callout p{margin:0}
.gw-canvas .notes-editor-mount .gw-toggle{margin:8px 0;border:1px solid var(--hairline);border-radius:10px;overflow:hidden}
.gw-canvas .notes-editor-mount .gw-toggle-summary{padding:8px 12px;font-weight:600;color:var(--ink);background:var(--canvas);cursor:default;user-select:none}
.gw-canvas .notes-editor-mount .gw-toggle-body{padding:8px 12px}
.gw-canvas .notes-editor-mount .gw-toggle[data-open="false"] .gw-toggle-body{display:none}
.gw-canvas .notes-editor-mount .gw-image{margin:12px 0;text-align:center}
.gw-canvas .notes-editor-mount .gw-image img{max-width:100%;border-radius:10px;box-shadow:var(--shadow-soft)}
.gw-canvas .notes-editor-mount .gw-image figcaption{color:var(--muted);font-size:13px}
.gw-canvas .notes-editor-mount .gw-image .gw-image-credit{margin-top:5px;font-size:11px;color:var(--fg3,#8A958F);line-height:1.3}
.gw-canvas .notes-editor-mount .gw-image .gw-image-credit a{color:var(--fg3,#8A958F);text-decoration:underline}
.gw-canvas .notes-editor-mount .gw-sticker{display:inline-block;font-size:30px;line-height:1;margin:6px 2px;cursor:default}
.gw-canvas .notes-editor-mount .gw-washi{height:12px;margin:14px 0;border:none;border-radius:6px;background:repeating-linear-gradient(45deg,var(--hl-amber) 0 10px,var(--hl-pink) 10px 20px)}

/* ── Creative theme: a HAND-DRAWN study-notebook look (handwriting fonts + dotted paper + marker
   headings + sketchy diagram frame). Turns the calm Pro note into the aesthetic of the sample
   study notes. Pro theme is untouched. ───────────────────────────────────────────────────────── */
.gw-canvas.creative .gw-page-scroll{
  background-color:#FBF8F1;
  background-image:radial-gradient(#E3DAC6 1.1px, transparent 1.2px);
  background-size:22px 22px;
}
.gw-canvas.creative .notes-editor-mount [contenteditable]{font-family:'Kalam','Patrick Hand',cursive;font-size:18px;line-height:1.75;color:#2B2A26}
.gw-canvas.creative .notes-editor-mount h1{font-family:'Caveat',cursive;font-size:36px;font-weight:700;color:#1F6FB2}
.gw-canvas.creative .notes-editor-mount h2{font-family:'Caveat',cursive;font-size:30px;font-weight:700;color:#15803D;display:inline-block;background:linear-gradient(transparent 70%, #FBE7A8 70%);padding:0 2px;margin:10px 0 4px}
.gw-canvas.creative .notes-editor-mount h3{font-family:'Patrick Hand',cursive;font-size:22px;font-weight:400;color:#B45309}
.gw-canvas.creative .notes-editor-mount ul li::marker{color:#1F6FB2}
.gw-canvas.creative .notes-editor-mount ol li::marker{color:#15803D;font-weight:700}
.gw-canvas.creative .notes-editor-mount .gw-callout{border-left-width:5px;border-radius:14px;box-shadow:0 1px 0 rgba(0,0,0,.03)}
.gw-canvas.creative .notes-editor-mount .gw-diagram-block{background:#FFFFFFAA;border:1.5px dashed #C9BFA6;border-radius:14px;padding:8px;margin:12px 0}
.gw-canvas.creative .notes-editor-mount .gw-diagram{max-width:100%;height:auto}
/* the woven "AI" / agency mint frame for AI-authored creative blocks stays, but warmer in Creative */
.gw-canvas.creative .notes-editor-mount .gw-callout[data-tone="warning"]{background:#FCEFD6}
.gw-canvas.creative .notes-editor-mount .gw-callout[data-tone="success"]{background:#E4F6EA}
.gw-canvas.creative .notes-editor-mount .gw-callout[data-tone="note"]{background:#EAF2FB;border-left-color:#1F6FB2}
/* ── Real tables (planner / Cornell / charting). Bordered cells, a tinted header row, zebra rows.
   Targets the editor's <table> directly so it works regardless of TipTap's class plumbing. ── */
.gw-canvas .notes-editor-mount .tableWrapper{margin:14px 0;overflow-x:auto}
.gw-canvas .notes-editor-mount table{border-collapse:collapse;width:100%;font-size:14px;table-layout:fixed;border:1.5px solid #B9C6C0}
.gw-canvas .notes-editor-mount table td,.gw-canvas .notes-editor-mount table th{border:1px solid #B9C6C0;padding:7px 10px;vertical-align:top;position:relative;min-width:60px}
.gw-canvas .notes-editor-mount table th{background:#EAF3EE;font-weight:700;text-align:left;color:#0B5E45}
.gw-canvas .notes-editor-mount table tr:nth-child(even) td{background:#F4F8F6}
.gw-canvas .notes-editor-mount table p{margin:0}
.gw-canvas .notes-editor-mount table .selectedCell:after{content:'';position:absolute;inset:0;background:rgba(14,154,110,.12);pointer-events:none}
.gw-canvas .notes-editor-mount table .column-resize-handle{position:absolute;right:-2px;top:0;bottom:0;width:4px;background:var(--accent);cursor:col-resize}
.gw-canvas.creative .notes-editor-mount table{border-color:#9FB5AB}
.gw-canvas.creative .notes-editor-mount table td,.gw-canvas.creative .notes-editor-mount table th{border-color:#9FB5AB}
.gw-canvas.creative .notes-editor-mount table th{background:#E4F6EA;font-family:'Patrick Hand',cursive;color:#15803D}
.gw-canvas.creative .notes-editor-mount table tr:nth-child(even) td{background:#EFFAF2}
.gw-canvas .notes-editor-mount .gw-washi[data-pattern="dots"]{background:radial-gradient(var(--hl-teal) 30%,transparent 32%) 0 0/14px 14px}
/* AI-authored blocks (Phase 3 AI block, suggestions) — mint frame + byline, per the design */
.gw-canvas .notes-ai-block,.gw-canvas .notes-suggestion{border:1.5px solid var(--mint-border);border-radius:16px;background:var(--mint-wash);overflow:hidden}
.gw-canvas .notes-ai-block-byline,.gw-canvas .notes-suggestion-byline{display:flex;align-items:center;gap:7px;padding:10px 16px;border-bottom:1px solid var(--mint-deep);font-size:12px;font-weight:600;color:var(--accent2)}
/* legacy 3-column shell only: drop the right column on narrow screens. The 2-col shell floats the assistant,
   so its .gw-rail (inside the panel) must NOT be hidden here. */
@media(max-width:1100px){.gw-shell:not(.gw-shell-2col){grid-template-columns:248px minmax(0,1fr)}.gw-shell:not(.gw-shell-2col) .gw-rail{display:none}}
/* Mobile/tablet: the notebooks rail becomes a slide-over DRAWER (opened by the topbar toggle) instead of
   stacking above the canvas, so the editor stays the full-width hero. Backdrop tap closes it. */
.gw-rail-toggle{display:none;width:32px;height:32px;flex:none;border-radius:9px;border:1px solid var(--hairline);background:var(--surface);color:var(--fg2);cursor:pointer;align-items:center;justify-content:center}
.gw-empty-topbar{display:none;padding:12px 16px;border-bottom:1px solid var(--hairline)}
.gw-topbar-left{display:flex;align-items:center;gap:12px;min-width:0}
.gw-notes-backdrop{display:none;position:absolute;inset:0;background:rgba(20,32,27,.34);z-index:150;opacity:0;transition:opacity .2s ease}
@media(max-width:899.98px){
  .gw-shell{grid-template-columns:1fr;position:relative}
  .gw-rail-toggle{display:inline-flex}
  .gw-empty-topbar{display:block}
  .gw-leftrail{position:absolute;top:0;left:0;bottom:0;z-index:200;width:min(84vw,300px);transform:translateX(-100%);transition:transform .22s ease;box-shadow:var(--shadow-pop);border-right:1px solid var(--hairline)}
  .gw-shell.rail-open .gw-leftrail{transform:translateX(0)}
  .gw-shell.rail-open .gw-notes-backdrop{display:block;opacity:1}
}
@media(prefers-reduced-motion:reduce){.gw-leftrail{transition:none}}

.notes-loading{padding:16px;text-align:center;color:var(--fg3);font-size:12px}

/* ════════════════ geneWeave Design System reference page (design handoff) ════════════════ */
.ds-root{height:100%;background:var(--canvas)}
.ds-scroll{height:100%;overflow-y:auto}
.ds-doc{max-width:1040px;margin:0 auto;padding:64px 40px 120px;display:flex;flex-direction:column;gap:80px}
.ds-eyebrow{font-family:var(--mono);font-size:12px;color:var(--accent);letter-spacing:.08em;text-transform:uppercase}
.ds-section{display:flex;flex-direction:column;gap:24px}
.ds-h2{font-family:var(--font-display);font-size:30px;font-weight:700;letter-spacing:-0.02em;margin:0;color:var(--ink)}
/* cover */
.ds-cover{display:flex;flex-direction:column;gap:18px}
.ds-brand{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.ds-brand-word{font-family:var(--font-display);font-size:22px;font-weight:700;letter-spacing:-0.02em}
.ds-display{font-family:var(--font-display);font-size:56px;line-height:1.08;font-weight:800;letter-spacing:-0.03em;margin:0;color:var(--ink)}
.ds-lead{font-size:18px;line-height:1.6;color:var(--muted);max-width:620px;margin:0}
.ds-chips{display:flex;gap:10px;margin-top:6px}
.ds-chip{font-family:var(--mono);font-size:12px;color:var(--muted);background:var(--surface);border:1px solid var(--hairline);border-radius:999px;padding:6px 14px}
.ds-chip-ai{color:var(--accent2);background:var(--mint);border-color:var(--mint-deep)}
/* principle cards */
.ds-two{display:grid;grid-template-columns:1fr 1fr;gap:24px}
.ds-card{background:var(--surface);border:1px solid var(--hairline);border-radius:14px;padding:24px;display:flex;flex-direction:column;gap:14px}
.ds-card-ai{border-left:3px solid var(--accent)}
.ds-card-head{display:flex;align-items:center;gap:10px}
.ds-ink-square{width:22px;height:22px;border-radius:7px;background:var(--ink)}
.ds-ai-square{width:22px;height:22px;border-radius:7px;background:var(--mint);display:inline-flex;align-items:center;justify-content:center}
.ds-card-title{font-weight:600;font-size:15px;color:var(--ink)}
.ds-card-body{font-size:14px;line-height:1.6;color:var(--muted);margin:0}
.ds-bubble{align-self:flex-start;font-size:13px;border-radius:14px;padding:10px 14px}
.ds-bubble-you{background:var(--ink);color:var(--surface)}
.ds-bubble-ai{background:var(--mint);color:var(--ink)}
/* logo lockups */
.ds-logo-row{display:flex;gap:18px;flex-wrap:wrap}
.ds-lockup{display:flex;flex-direction:column;align-items:center;gap:10px;background:var(--surface);border:1px solid var(--hairline);border-radius:14px;padding:28px 40px}
.ds-lockup-mint{background:var(--mint);border-color:var(--mint-deep)}
.ds-lockup-ink{background:var(--ink)}
.ds-lockup-cap{font-family:var(--mono);font-size:11px;color:var(--muted)}
.ds-cap-rev{color:var(--surface)}
.ds-note{font-size:14px;line-height:1.6;color:var(--muted);margin:0;max-width:640px}
/* color swatches */
.ds-swatch-label{font-family:var(--mono);font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-top:8px}
.ds-swatch-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.ds-swatch{display:flex;gap:12px;align-items:center;background:var(--surface);border:1px solid var(--hairline);border-radius:12px;padding:12px}
.ds-swatch-chip{width:44px;height:44px;border-radius:10px;flex:none;box-shadow:inset 0 0 0 1px rgba(20,32,27,.08)}
.ds-swatch-name{font-weight:600;font-size:13px;color:var(--ink)}
.ds-swatch-hex{font-family:var(--mono);font-size:11px;color:var(--muted)}
.ds-swatch-use{font-size:11px;color:var(--fg3)}
/* type */
.ds-type-row{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.ds-type-card{background:var(--surface);border:1px solid var(--hairline);border-radius:12px;padding:20px;display:flex;flex-direction:column;gap:8px}
.ds-type-sample{color:var(--ink)}
.ds-type-display{font-family:var(--font-display);font-size:28px;font-weight:800;letter-spacing:-0.02em}
.ds-type-body{font-family:var(--font);font-size:20px;font-weight:500}
.ds-type-mono{font-family:var(--mono);font-size:16px}
.ds-type-meta{font-size:12px;color:var(--muted)}
/* spacing */
.ds-scale{display:flex;flex-direction:column;gap:12px}
.ds-scale-row{display:flex;align-items:center;gap:14px}
.ds-scale-bar{height:14px;background:var(--accent);border-radius:3px}
.ds-scale-cap{font-family:var(--mono);font-size:12px;color:var(--muted)}
.ds-radius-row{display:flex;gap:14px;margin-top:10px}
.ds-radius{width:80px;height:80px;background:var(--mint);border:1px solid var(--mint-deep);display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:12px;color:var(--accent2)}
/* buttons & forms */
.ds-btn-row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.ds-btn{font-size:13px;font-weight:600;border-radius:999px;padding:9px 18px;cursor:pointer;border:1px solid transparent}
.ds-btn-primary{background:var(--accent);color:#fff;border-color:var(--accent)}
.ds-btn-ghost{background:var(--surface);color:var(--muted);border-color:var(--hairline)}
.ds-btn-mint{background:var(--mint);color:var(--accent2);border-color:var(--mint-deep);display:inline-flex;align-items:center;gap:7px}
.ds-field-row{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:6px}
.ds-input{flex:1;min-width:240px;padding:10px 14px;border:1px solid var(--hairline);border-radius:10px;background:var(--surface);color:var(--ink);font-size:14px}
.ds-pill-on{font-size:12px;font-weight:600;color:var(--accent2);background:var(--mint);border-radius:999px;padding:5px 14px}
.ds-pill-off{font-size:12px;font-weight:600;color:var(--fg3);background:var(--bg3);border-radius:999px;padding:5px 14px}
/* agent action card */
.ds-action-card{max-width:460px;background:var(--mint-wash);border:1.5px solid var(--mint-border);border-radius:16px;padding:16px;display:flex;flex-direction:column;gap:10px}
.ds-action-byline{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:600;color:var(--accent2)}
.ds-action-body{font-size:14px;line-height:1.6;color:var(--ink)}
.ds-action-foot{display:flex;align-items:center;gap:7px;font-family:var(--mono);font-size:11px;color:var(--muted)}
.ds-done-dot{width:6px;height:6px;border-radius:50%;background:var(--accent)}
/* plain-language table */
.ds-table{background:var(--surface);border:1px solid var(--hairline);border-radius:12px;overflow:hidden}
.ds-table-head{display:flex;justify-content:space-between;padding:12px 18px;border-bottom:1px solid var(--hairline);font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--fg3)}
.ds-table-row{display:flex;align-items:center;gap:14px;padding:12px 18px;border-bottom:1px solid var(--hairline)}
.ds-table-row:last-child{border-bottom:none}
.ds-table-from{font-family:var(--mono);font-size:13px;color:var(--muted);flex:1}
.ds-table-arrow{color:var(--accent)}
.ds-table-to{font-size:14px;font-weight:600;color:var(--ink);flex:1}
@media(max-width:760px){.ds-two,.ds-swatch-grid,.ds-type-row{grid-template-columns:1fr}.ds-display{font-size:40px}}

/* ════════════════ Admin (Builder design alignment) ════════════════ */
/* Active/selected record row: mint fill + a 2px emerald inset bar (the design's signature). */
.admin-data-row.admin-data-row-selected{background:var(--mint);box-shadow:inset 2px 0 0 var(--accent)}
.admin-data-row{cursor:pointer;transition:background .1s}
.admin-data-row:hover{background:var(--bg3)}
/* The "Administration / <type>" header → calm eyebrow + display title, like the design. */
.dash-view>h2{font-family:var(--font-display);font-weight:700;letter-spacing:-0.02em}
/* Record-editor action bar: the design's sticky save row — Cancel (ghost) + Save (emerald). */
.admin-form-action-bar{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--surface) 88%,transparent);backdrop-filter:blur(6px)}
.admin-form-btn-save{box-shadow:var(--shadow-soft)}
/* Eyebrow treatment for the admin breadcrumb trail. */
.admin-breadcrumbs{font-family:var(--mono);font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--fg3)}
.admin-breadcrumbs .crumb-current{color:var(--ink)}

/* ════════════════ geneWeave Builder — 3-pane "Building blocks" (design handoff) ════════════════ */
.bld-app{display:flex;height:100vh;width:100vw;overflow:hidden;font-family:var(--font);color:var(--ink);background:var(--canvas)}
/* left ASSISTANT SETUP nav */
.bld-nav{width:220px;flex:none;background:var(--surface);border-right:1px solid var(--hairline);display:flex;flex-direction:column;padding:18px 14px}
.bld-brand{display:flex;align-items:center;gap:11px;padding:4px 8px 22px;background:none;border:none;cursor:pointer;width:100%}
.bld-brand:hover{opacity:.85}
.bld-brand-word{font-family:var(--font-display);font-size:16px;font-weight:700;letter-spacing:-0.02em}
.bld-nav-body{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:10px}
.bld-nav-group{display:flex;flex-direction:column;gap:3px}
.bld-nav-label{font-family:var(--mono);font-size:10px;letter-spacing:.1em;color:var(--fg3)}
.bld-nav-grouphead{display:flex;align-items:center;justify-content:space-between;padding:6px 10px 4px;background:none;border:none;cursor:pointer;width:100%}
.bld-nav-caret{font-size:9px;color:var(--fg3);transition:transform .15s}
.bld-nav-caret.open{transform:rotate(180deg)}
.bld-nav-list{display:flex;flex-direction:column;gap:2px}
.bld-nav-itemlabel{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bld-nav-item{display:flex;align-items:center;gap:10px;padding:9px 12px;font-size:13px;color:var(--muted);border-radius:10px;cursor:pointer}
.bld-nav-item:hover{background:var(--bg3)}
.bld-nav-item.active{background:var(--mint);color:var(--accent2);font-weight:600}
.bld-nav-item.plain{}
.bld-nav-dot{width:7px;height:7px;border-radius:50%;background:transparent;flex:none}
.bld-nav-item.active .bld-nav-dot{background:var(--accent)}
.bld-nav-foot{border-top:1px solid var(--hairline);padding-top:12px;display:flex;flex-direction:column;gap:2px}
.bld-nav-arrow{display:inline-flex;color:var(--muted)}
.bld-nav-account{display:flex;align-items:center;gap:10px;padding:9px 12px;font-size:13px;color:var(--ink)}
.bld-account-avatar{width:24px;height:24px;border-radius:50%;background:var(--ink);color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:600}
/* collection pane */
.bld-collection{width:360px;flex:none;background:var(--surface);border-right:1px solid var(--hairline);display:flex;flex-direction:column;min-width:0}
.bld-coll-head{padding:22px 22px 16px;display:flex;flex-direction:column;gap:16px;border-bottom:1px solid var(--hairline)}
.bld-coll-titlebar{display:flex;align-items:center;justify-content:space-between}
.bld-coll-title-wrap{display:flex;align-items:baseline;gap:10px}
.bld-coll-title{font-family:var(--font-display);font-size:20px;font-weight:700;letter-spacing:-0.02em;margin:0}
.bld-coll-count{font-family:var(--mono);font-size:12px;color:var(--fg3)}
.bld-new-btn{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600;color:#fff;background:var(--accent);border:none;border-radius:999px;padding:8px 15px;cursor:pointer}
.bld-new-btn:hover{background:var(--accent2)}
.bld-new-plus{font-size:15px;line-height:1}
.bld-coll-search-row{display:flex;gap:8px}
.bld-coll-search{flex:1;display:flex;align-items:center;gap:8px;background:var(--canvas);border:1px solid var(--hairline);border-radius:10px;padding:8px 12px}
.bld-coll-search-ic{display:inline-flex;color:var(--fg3)}
.bld-coll-search-ph{font-size:13px;color:var(--fg3)}
.bld-coll-filter{background:var(--canvas);border:1px solid var(--hairline);border-radius:10px;padding:0 11px;cursor:pointer;color:var(--muted)}
.bld-coll-cols{display:flex;align-items:center;gap:6px;font-family:var(--mono);font-size:10px;letter-spacing:.08em;color:var(--fg3)}
.bld-col-name{flex:1}
.bld-col-status{width:54px;text-align:right}
.bld-coll-list{flex:1;overflow-y:auto;padding:8px}
.bld-coll-empty{font-size:13px;color:var(--fg3);padding:14px}
.bld-row{display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:12px;cursor:pointer;margin-bottom:2px}
.bld-row:hover{background:var(--bg3)}
.bld-row.active{background:var(--mint);box-shadow:inset 2px 0 0 var(--accent)}
.bld-row-dot{width:8px;height:8px;border-radius:50%;background:#C9D6D0;flex:none}
.bld-row-dot.on{background:var(--accent)}
.bld-row-dot.neutral{background:var(--bg4)}
.bld-row-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.bld-row-name{font-size:14px;font-weight:500;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bld-row-key{font-family:var(--mono);font-size:11px;color:var(--fg3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bld-pill{flex:none;font-size:11px;font-weight:600;padding:3px 10px;border-radius:999px}
.bld-pill.on{background:var(--mint);color:var(--accent2)}
.bld-pill.off{background:var(--bg3);color:var(--fg3)}
.bld-coll-foot{border-top:1px solid var(--hairline);padding:12px 22px;display:flex;align-items:center;justify-content:space-between}
.bld-coll-range{font-family:var(--mono);font-size:11px;color:var(--fg3)}
.bld-coll-pager{display:flex;gap:4px}
.bld-pager-btn{width:28px;height:28px;border:1px solid var(--hairline);border-radius:8px;background:var(--surface);color:var(--fg3);cursor:default}
/* editor pane */
.bld-editor{flex:1;min-width:0;display:flex;flex-direction:column;background:var(--canvas)}
.bld-editor-head{background:var(--surface);border-bottom:1px solid var(--hairline);padding:18px 32px;display:flex;align-items:center;justify-content:space-between;gap:16px}
.bld-editor-titles{display:flex;flex-direction:column;gap:3px;min-width:0}
.bld-editor-eyebrow{font-family:var(--mono);font-size:10px;letter-spacing:.08em;color:var(--fg3)}
.bld-editor-name{font-family:var(--font-display);font-size:19px;font-weight:700;letter-spacing:-0.02em;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bld-editor-more{width:36px;height:36px;border:1px solid var(--hairline);border-radius:10px;background:var(--surface);color:var(--muted);cursor:pointer;font-size:17px;line-height:1;flex:none}
.bld-editor-empty{flex:1;display:flex;align-items:center;justify-content:center;color:var(--fg3);font-size:14px}
.bld-editor-scroll{flex:1;overflow-y:auto;padding:32px}
.bld-form{max-width:640px;margin:0 auto;display:flex;flex-direction:column;gap:36px}
.bld-section{display:flex;flex-direction:column;gap:20px}
.bld-section-label{font-family:var(--mono);font-size:11px;letter-spacing:.1em;color:var(--accent);border-bottom:1px solid var(--hairline);padding-bottom:10px}
.bld-field{display:flex;flex-direction:column;gap:7px}
.bld-field-head{display:flex;align-items:center;justify-content:space-between}
.bld-label{font-size:13px;font-weight:600;color:var(--ink)}
.bld-input{font-size:14px;color:var(--ink);background:var(--surface);border:1px solid var(--hairline);border-radius:10px;padding:11px 13px;outline:none}
.bld-input:focus,.bld-textarea:focus,.bld-json:focus{border-color:var(--accent)}
.bld-mono{font-family:var(--mono);font-size:13px}
.bld-version{max-width:200px}
.bld-hint{font-size:12px;color:var(--muted)}
.bld-keyhint{font-family:var(--mono);color:var(--accent2)}
.bld-textarea{font-size:14px;line-height:1.6;color:var(--ink);background:var(--surface);border:1px solid var(--hairline);border-radius:10px;padding:11px 13px;outline:none;resize:vertical;font-family:inherit}
.bld-select{font-size:14px;color:var(--ink);background:var(--surface);border:1px solid var(--hairline);border-radius:10px;padding:11px 13px;outline:none;cursor:pointer}
.bld-select:focus{border-color:var(--accent)}
.bld-danger-wrap{margin-top:0}
.bld-editor-empty-inline{font-size:13px;color:var(--fg3);padding:8px 0}
.bld-code{background:#14201B;border-radius:10px;overflow:hidden;border:1px solid #14201B}
.bld-code-bar{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid #243630}
.bld-code-meta{font-family:var(--mono);font-size:10px;color:#6f857b;letter-spacing:.08em}
.bld-code-area{width:100%;display:block;font-family:var(--mono);font-size:12.5px;line-height:1.7;color:#cfe8dd;background:#14201B;border:none;padding:14px;outline:none;resize:vertical}
.bld-json{font-family:var(--mono);font-size:12.5px;line-height:1.7;color:var(--ink);background:var(--surface);border-radius:10px;padding:12px 13px;outline:none;resize:vertical;border:1px solid var(--hairline)}
.bld-json.invalid{border-color:#E0B49C}
.bld-json-error{font-size:12px;color:#C2562B;display:flex;align-items:center;gap:6px}
.bld-err-ic{width:14px;height:14px;border-radius:50%;border:1.5px solid currentColor;display:inline-flex;align-items:center;justify-content:center;font-size:10px;font-weight:700}
.bld-mini-btn{font-size:11px;border-radius:7px;padding:4px 9px;cursor:pointer;border:1px solid var(--hairline);background:var(--surface);color:var(--muted)}
.bld-mini-emerald{color:var(--accent2);border-color:var(--mint-deep)}
.bld-chips{display:flex;flex-wrap:wrap;gap:7px;align-items:center;background:var(--surface);border:1px solid var(--hairline);border-radius:10px;padding:9px 11px}
.bld-chip{display:inline-flex;align-items:center;gap:6px;background:var(--mint);color:var(--accent2);font-size:12px;font-weight:500;padding:5px 6px 5px 11px;border-radius:999px}
.bld-chip-x{border:none;background:var(--mint-deep);color:var(--accent2);width:16px;height:16px;border-radius:50%;cursor:pointer;font-size:11px;line-height:1;display:inline-flex;align-items:center;justify-content:center}
.bld-tag-input{flex:1;min-width:80px;border:none;outline:none;background:transparent;font-size:13px;color:var(--ink)}
.bld-avail-card{display:flex;align-items:center;justify-content:space-between;background:var(--surface);border:1px solid var(--hairline);border-radius:12px;padding:16px 18px}
.bld-avail-text{display:flex;flex-direction:column;gap:3px}
.bld-avail-title{font-size:14px;font-weight:600;color:var(--ink)}
.bld-avail-sub{font-size:12px;color:var(--muted)}
.bld-toggle{width:44px;height:26px;border-radius:999px;cursor:pointer;flex:none;position:relative;transition:background .18s ease;background:#D5DEDA}
.bld-toggle.on{background:var(--accent)}
.bld-knob{position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:transform .18s ease}
.bld-toggle.on .bld-knob{transform:translateX(18px)}
.bld-danger{display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border:1px solid var(--danger-zone-border);border-radius:12px;background:var(--danger-zone-bg)}
.bld-danger-text{display:flex;flex-direction:column;gap:3px}
.bld-danger-title{font-size:13px;font-weight:600;color:var(--danger-zone-fg)}
.bld-danger-sub{font-size:12px;color:#9c7d68}
.bld-danger-btn{font-size:13px;font-weight:600;color:var(--danger-zone-fg);background:var(--surface);border:1px solid #EBD3C2;border-radius:999px;padding:8px 16px;cursor:pointer}
.bld-actionbar{background:var(--surface);border-top:1px solid var(--hairline);padding:14px 32px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex:none}
.bld-dirty{font-size:12px;color:var(--fg3);display:flex;align-items:center;gap:7px}
.bld-dirty.on{color:var(--amber)}
.bld-dirty-dot{width:7px;height:7px;border-radius:50%;background:currentColor}
.bld-actions{display:flex;gap:10px}
.bld-btn-ghost{font-size:14px;font-weight:600;color:var(--muted);background:var(--surface);border:1px solid var(--hairline);border-radius:999px;padding:10px 20px;cursor:pointer}
.bld-btn-save{font-size:14px;font-weight:600;color:#fff;background:var(--accent);border:none;border-radius:999px;padding:10px 22px;cursor:pointer}
.bld-btn-save:hover{background:var(--accent2)}
.bld-btn-save.disabled{opacity:.5;cursor:not-allowed}
.bld-toast{position:fixed;bottom:84px;left:50%;transform:translateX(-50%);background:var(--ink);color:#fff;font-size:13px;font-weight:500;padding:11px 20px;border-radius:999px;box-shadow:0 4px 16px rgba(20,32,27,.2);display:flex;align-items:center;gap:9px;z-index:50}
.bld-toast-check{display:inline-flex}
@media(max-width:980px){.bld-collection{width:300px}}

.notes-items{flex:1;overflow-y:auto;padding:0 8px 12px}
.notes-section{margin-bottom:8px}
.notes-section-label{font-size:10px;font-weight:700;color:var(--fg3);text-transform:uppercase;letter-spacing:.06em;padding:8px 6px 4px}
.notes-empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:24px 12px;color:var(--fg3);font-size:12px;text-align:center}
.notes-new-btn-lg{margin-top:4px;font-size:12px;padding:8px 16px;border-radius:8px;background:var(--accent);color:#fff;border:none;cursor:pointer;font-weight:600}
/* Note row */
.note-row{display:flex;align-items:center;gap:8px;padding:8px 8px;border-radius:8px;cursor:pointer;transition:background .15s;position:relative}
.note-row:hover{background:var(--bg2)}
.note-row.active{background:var(--bg3)}
.note-row-icon{font-size:16px;width:24px;text-align:center;flex-shrink:0}
.note-row-body{flex:1;min-width:0}
.note-row-title{font-size:13px;color:var(--fg1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:500}
.note-row-meta{font-size:11px;color:var(--fg3);display:flex;gap:6px;align-items:center;margin-top:2px}
.note-fav-btn{background:none;border:none;color:var(--fg3);cursor:pointer;font-size:14px;padding:2px;opacity:.5;flex-shrink:0}
.note-fav-btn:hover{opacity:1}
.note-fav-btn.active{color:#f59e0b;opacity:1}
.note-sens-badge{font-size:10px;padding:1px 5px;border-radius:4px;background:#fef3c7;color:#92400e;font-weight:600}
/* Templates gallery */
/* Template gallery — the whole panel scrolls inside the (overflow:hidden) canvas; header + search stay pinned */
.notes-templates{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;background:var(--surface)}
.notes-templates-header{position:sticky;top:0;z-index:5;background:var(--surface);border-bottom:1px solid var(--hairline);padding:18px 24px 14px;display:flex;flex-direction:column;gap:13px}
.notes-templates-headrow{display:flex;align-items:flex-start;gap:14px}
.notes-templates-titlewrap{display:flex;flex-direction:column;gap:2px;min-width:0}
.notes-templates-title{font-size:18px;font-weight:700;color:var(--fg)}
.notes-templates-sub{font-size:12.5px;color:var(--fg3);line-height:1.4}
.notes-templates-searchbox{position:relative;display:flex;align-items:center;max-width:440px;width:100%}
.notes-templates-search{width:100%;box-sizing:border-box;padding:9px 30px 9px 34px;border:1px solid var(--bg4);border-radius:10px;font:inherit;font-size:13.5px;background:var(--bg2);color:var(--fg)}
.notes-templates-search::placeholder{color:var(--fg3)}
.notes-templates-search:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--mint-wash)}
.notes-templates-search-ic{position:absolute;left:11px;display:inline-flex;color:var(--fg3);pointer-events:none}
.notes-templates-search-ic svg{width:15px;height:15px}
.notes-templates-search-clear{position:absolute;right:8px;width:20px;height:20px;border:none;background:var(--bg3);color:var(--fg2);border-radius:50%;cursor:pointer;font-size:14px;line-height:1;display:flex;align-items:center;justify-content:center}
.notes-templates-search-clear:hover{background:var(--bg4);color:var(--fg)}
.notes-templates-cats{display:flex;flex-direction:column;gap:26px;padding:20px 24px 48px}
.notes-template-cat{}
.notes-template-cat-label{display:flex;align-items:center;gap:8px;font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--fg3);margin-bottom:12px}
.notes-template-cat-count{font-size:10.5px;font-weight:600;color:var(--fg3);background:var(--bg3);border-radius:999px;padding:1px 7px;letter-spacing:0}
.notes-template-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}
.notes-template-card{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:15px 15px 16px;border:1px solid var(--bg4);border-radius:14px;cursor:pointer;background:var(--bg2);text-align:left;font:inherit;transition:border-color .15s,box-shadow .15s,transform .06s}
.notes-template-card:hover{border-color:var(--accent);box-shadow:0 4px 16px rgba(20,32,27,.08)}
.notes-template-card:active{transform:translateY(1px)}
.notes-template-card:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.notes-template-icon{width:38px;height:38px;border-radius:10px;background:var(--mint-wash);border:1px solid var(--mint-border);color:var(--accent2);display:inline-flex;align-items:center;justify-content:center;flex:none}
.notes-template-icon svg{width:20px;height:20px}
.notes-template-title{font-size:13px;font-weight:600;color:var(--fg);line-height:1.3}
.notes-template-desc{font-size:11.5px;color:var(--fg3);text-align:left;line-height:1.45}
.notes-templates-noresult{padding:48px 24px;text-align:center}
.notes-templates-noresult-title{font-size:14px;font-weight:600;color:var(--fg2)}
.notes-templates-noresult-sub{font-size:12.5px;color:var(--fg3);margin-top:4px}
/* weaveNotes Phase 6 — archived / trash view */
.notes-archive-list{display:flex;flex-direction:column;gap:8px}
.notes-archive-row{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--bg4);border-radius:10px;background:var(--bg2)}
.notes-archive-icon{font-size:16px}
.notes-archive-title{flex:1;font-size:13px;color:var(--fg1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.notes-archive-restore,.notes-archive-delete{font-size:12px;padding:5px 10px;border-radius:8px;border:1px solid var(--bg4);background:var(--bg1);color:var(--fg2);cursor:pointer}
.notes-archive-restore:hover{border-color:var(--accent);color:var(--accent)}
.notes-archive-delete:hover{border-color:var(--danger,#dc2626);color:var(--danger,#dc2626)}
/* Editor panel */
.notes-editor-panel{display:flex;flex-direction:column;height:100%;overflow:hidden}
.notes-editor-top{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--bg4);flex-shrink:0}
.notes-editor-toolbar{display:flex;gap:6px;align-items:center}
.notes-back-btn{font-size:12px;color:var(--fg3);background:none;border:none;cursor:pointer;padding:4px 8px;border-radius:6px}
.notes-back-btn:hover{background:var(--bg3);color:var(--fg1)}
.notes-fav-btn{background:none;border:none;color:var(--fg3);cursor:pointer;font-size:16px;padding:4px;border-radius:6px}
.notes-fav-btn:hover{background:var(--bg3)}
.notes-fav-btn.active{color:#f59e0b}
.notes-extract-btn{font-size:12px;padding:4px 10px;border-radius:8px;background:var(--bg2);color:var(--fg2);border:1px solid var(--bg4);cursor:pointer}
.notes-extract-btn:hover{background:var(--bg3)}
.notes-delete-btn{font-size:14px;padding:4px 8px;border-radius:6px;background:none;color:var(--fg3);border:none;cursor:pointer}
.notes-delete-btn:hover{background:#fef2f2;color:#dc2626}
.notes-extract-result{margin:0 16px;padding:8px 12px;background:#d1fae5;color:#065f46;border-radius:8px;font-size:12px;font-weight:500}
.notes-editor-header{display:flex;align-items:center;gap:12px;padding:16px 20px 8px;flex-shrink:0}
.notes-editor-icon{font-size:28px;cursor:pointer;width:36px;text-align:center;border-radius:6px;padding:2px}
.notes-editor-icon:hover{background:var(--bg2)}
.notes-title-input{flex:1;font-size:22px;font-weight:700;color:var(--fg1);border:none;background:transparent;outline:none;padding:4px 0}
.notes-title-input::placeholder{color:var(--fg3)}
.notes-editor-mount{flex:1;overflow-y:auto;padding:0 20px 24px}
.notes-editor-content{min-height:300px;outline:none}
.notes-editor-content .ProseMirror{outline:none;min-height:300px;font-size:14px;line-height:1.7;color:var(--fg1)}
.notes-editor-content .ProseMirror p.is-editor-empty:first-child::before{content:attr(data-placeholder);color:var(--fg3);pointer-events:none;float:left;height:0}
.notes-editor-content h1{font-size:22px;font-weight:700;color:var(--fg1);margin:1em 0 .3em}
.notes-editor-content h2{font-size:18px;font-weight:600;color:var(--fg1);margin:.9em 0 .3em}
.notes-editor-content h3{font-size:15px;font-weight:600;color:var(--fg2);margin:.8em 0 .3em}
.notes-editor-content ul{padding-left:1.4em;list-style:disc}
.notes-editor-content ol{padding-left:1.4em;list-style:decimal}
.notes-editor-content blockquote{border-left:3px solid var(--bg4);padding-left:12px;color:var(--fg2);margin:8px 0}
.notes-editor-content pre{background:var(--bg2);border-radius:6px;padding:10px 14px;font-family:monospace;font-size:13px;overflow-x:auto}
.notes-editor-content code{background:var(--bg3);border-radius:3px;padding:1px 4px;font-family:monospace;font-size:12px}
.notes-editor-content hr{border:none;border-top:1px solid var(--bg4);margin:12px 0}
.notes-editor-content li[data-type="taskItem"]{display:flex;gap:8px;align-items:flex-start;list-style:none;padding-left:0}
.notes-editor-content li[data-type="taskItem"] input[type="checkbox"]{margin-top:3px;flex-shrink:0;accent-color:var(--accent)}
/* Bubble toolbar */
.notes-bubble-wrapper{position:absolute;z-index:200;pointer-events:none}
.notes-bubble-toolbar{display:flex;gap:2px;background:var(--bg1);border:1px solid var(--bg4);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.15);padding:3px;pointer-events:all}
.notes-bubble-btn{font-size:12px;font-weight:700;padding:4px 8px;border-radius:5px;border:none;background:none;color:var(--fg1);cursor:pointer}
.notes-bubble-btn:hover{background:var(--bg3)}
/* weaveNotes Phase 1 — bubble highlighter swatches + text-colour picker */
.notes-bubble-sep{width:1px;align-self:stretch;background:var(--bg4);margin:0 3px}
.notes-bubble-swatch{width:16px;height:16px;border-radius:50%;border:1px solid rgba(0,0,0,.12);cursor:pointer;padding:0;align-self:center}
.notes-bubble-swatch:hover{transform:scale(1.12)}
.notes-bubble-colorwrap{display:inline-flex;align-items:center;gap:2px}
.notes-bubble-color-a{font-weight:800}
.notes-bubble-colorwrap .notes-bubble-colordot{display:none;width:14px;height:14px;border-radius:50%;border:1px solid rgba(0,0,0,.12);cursor:pointer;padding:0}
.notes-bubble-colorwrap.open .notes-bubble-colordot{display:inline-block}
/* weaveNotes Phase 2 — the floating AI selection card (spec §4 / §10) */
.notes-aicard-pill{display:inline-flex;align-items:center;gap:5px;font-size:12.5px;font-weight:700;color:#fff;background:var(--accent,#0E9A6E);border:none;border-radius:999px;padding:6px 12px;cursor:pointer;box-shadow:0 8px 28px rgba(20,32,27,.18);pointer-events:all}
.notes-aicard-pill:hover{background:var(--accent2,#0B7A57)}
.notes-aicard-spark{color:#FAC775}
.notes-aicard{width:344px;background:var(--surface,#fff);border:1px solid var(--mint-border,#DCEFE5);border-radius:16px;box-shadow:0 8px 28px rgba(20,32,27,.12);padding:10px;pointer-events:all;font-size:13px}
.notes-aicard-prompt{display:flex;align-items:center;gap:7px;border:1px solid var(--hairline,#E7ECEA);border-radius:12px;padding:7px 10px;margin-bottom:8px}
.notes-aicard-prompt .notes-aicard-spark{color:var(--accent,#0E9A6E);font-weight:800}
.notes-aicard-input{flex:1;border:none;outline:none;background:transparent;font-size:13px;color:var(--ink,#14201B)}
.notes-aicard-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:9px}
.notes-aicard-chip{font-size:12px;font-weight:600;color:var(--ink,#14201B);background:var(--mint,#E8F5EE);border:1px solid var(--mint-deep,#DCEFE5);border-radius:999px;padding:5px 11px;cursor:pointer}
.notes-aicard-chip:hover{background:var(--mint-deep,#DCEFE5)}
.notes-aicard-chip:disabled{opacity:.5;cursor:default}
.notes-aicard-colors{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding-top:8px;border-top:1px solid var(--hairline,#E7ECEA)}
.notes-aicard-colorlabel{font-size:11.5px;font-weight:600;color:var(--muted,#5E6E67)}
.notes-aicard-swatch{width:18px;height:18px;border-radius:50%;border:1px solid rgba(0,0,0,.12);cursor:pointer;padding:0}
.notes-aicard-swatch:hover{transform:scale(1.12)}
.notes-aicard-sep{width:1px;height:16px;background:var(--hairline,#E7ECEA);margin:0 2px}
.notes-aicard-scheme{font-size:12px;border:1px solid var(--hairline,#E7ECEA);border-radius:8px;padding:3px 6px;background:var(--surface,#fff);color:var(--ink,#14201B)}
.notes-aicard-go{padding:4px 10px}
.notes-aicard-status{min-height:16px;margin-top:8px;font-size:11.5px;font-weight:600;color:var(--accent2,#0B7A57)}
/* weaveNotes Phase 3 — live collaborator cursors + presence avatars */
.notes-cursors-overlay{position:absolute;inset:0;pointer-events:none;z-index:20;overflow:visible}
.notes-cursor-caret{position:absolute;width:2px;border-radius:1px;pointer-events:none}
.notes-cursor-label{position:absolute;top:-16px;left:-1px;font-size:10px;font-weight:700;color:#fff;padding:1px 5px;border-radius:6px 6px 6px 0;white-space:nowrap;line-height:1.4}
.gw-presence-avatars{display:inline-flex;align-items:center}
.gw-presence-avatars .gw-avatar{margin-left:-6px;box-shadow:0 0 0 2px var(--surface,#fff)}
.gw-presence-avatars .gw-avatar:first-child{margin-left:0}
.gw-avatar-live{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;color:#fff;font-size:11px;font-weight:800}
/* weaveNotes Phase 4 — diagram + ink blocks + the card's create chips */
.notes-aicard-create{background:var(--mint,#E8F5EE);border-color:var(--accent,#0E9A6E);font-weight:700}
.gw-canvas .notes-editor-mount .gw-diagram-block{display:block;margin:12px 0;padding:10px;border:1px solid var(--hairline,#E7ECEA);border-radius:12px;background:var(--surface,#fff);overflow-x:auto;text-align:center}
.gw-canvas .notes-editor-mount .gw-diagram-block svg{max-width:100%;height:auto}
.gw-canvas .notes-editor-mount .gw-diagram-block[data-author="ai"],
.gw-canvas .notes-editor-mount .gw-ink-block[data-author="ai"]{border-color:var(--mint-border,#DCEFE5);background:var(--mint-wash,#F2FAF6);box-shadow:inset 3px 0 0 var(--accent,#0E9A6E)}
.gw-canvas .notes-editor-mount .gw-ink-block{display:block;margin:12px 0;border:1px solid var(--hairline,#E7ECEA);border-radius:12px;background:var(--surface,#fff);overflow:hidden}
.gw-ink-toolbar{display:flex;align-items:center;gap:5px;padding:6px 8px;border-bottom:1px solid var(--hairline,#E7ECEA);background:var(--canvas,#F6F8F7)}
.gw-ink-swatch{width:16px;height:16px;border-radius:50%;border:1px solid rgba(0,0,0,.15);cursor:pointer;padding:0}
.gw-ink-erase,.gw-ink-clear{font-size:11px;font-weight:600;border:1px solid var(--hairline,#E7ECEA);background:var(--surface,#fff);border-radius:6px;padding:2px 7px;cursor:pointer;color:var(--ink,#14201B)}
.gw-ink-surface{position:relative;min-height:120px;touch-action:none;cursor:crosshair}
.gw-ink-surface svg{display:block;max-width:100%}
.gw-ink-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--fg3,#8A958F);font-size:13px;pointer-events:none}
/* weaveNotes — editable diagram: a click-to-edit node + a small editor toolbar under the canvas */
.gw-diagram-canvas svg{display:block;max-width:100%;margin:0 auto}
.gw-dnode-sel rect,.gw-dnode-sel polygon,.gw-dnode-sel ellipse,.gw-dnode-sel path{stroke:#0E9A6E !important;stroke-width:2.5 !important}
.gw-diagram-editor{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:7px 8px;margin-top:6px;border-top:1px solid var(--hairline,#E7ECEA)}
.gw-diagram-btn{font-size:11px;font-weight:600;border:1px solid var(--hairline,#E7ECEA);background:var(--surface,#fff);border-radius:6px;padding:3px 8px;cursor:pointer;color:var(--ink,#14201B)}
.gw-diagram-btn:hover{background:var(--canvas,#F6F8F7)}
.gw-diagram-label{font-size:12px;border:1px solid var(--hairline,#E7ECEA);border-radius:6px;padding:3px 7px;min-width:120px;color:var(--ink,#14201B);background:var(--surface,#fff)}
.gw-diagram-swatch{width:16px;height:16px;border-radius:50%;border:1px solid rgba(0,0,0,.15);cursor:pointer;padding:0}
.gw-diagram-hint{font-size:11px;color:var(--fg3,#8A958F)}
/* weaveNotes Phase 4 (creative expansion) — the card Visualize row + AI illustrations/images */
.notes-aicard-visual{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding-top:8px;border-top:1px solid var(--hairline,#E7ECEA);margin-top:8px}
.notes-aicard-visual .notes-aicard-spark{color:var(--accent,#0E9A6E);font-weight:800}
.gw-canvas .notes-editor-mount .gw-image[data-author="ai"]{padding:8px;border-radius:12px;background:var(--mint-wash,#F2FAF6);box-shadow:inset 3px 0 0 var(--accent,#0E9A6E)}
.gw-canvas .notes-editor-mount .gw-image[data-author="ai"] img{border-radius:8px}
/* weaveNotes Phase 5 — the Study (flashcard review) screen */
.gw-study{align-items:stretch}
.gw-study-top{display:flex;align-items:center;gap:14px;padding:14px 28px;border-bottom:1px solid var(--hairline,#E7ECEA);flex-wrap:wrap}
.gw-study-title{font-weight:700;font-size:15px;color:var(--ink,#14201B)}
.gw-study-stats{margin-left:auto;display:flex;gap:12px}
.gw-study-stat{font-size:12px;color:var(--muted,#5E6E67)}
.gw-study-stat b{color:var(--ink,#14201B)}
.gw-study-body{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding:36px 24px;gap:18px}
.gw-study-progress{font-size:12px;font-weight:600;color:var(--muted,#5E6E67)}
.gw-study-card{width:min(560px,92%);min-height:200px;background:var(--surface,#fff);border:1px solid var(--hairline,#E7ECEA);border-radius:16px;box-shadow:var(--shadow-soft,0 1px 3px rgba(20,32,27,.06));padding:28px 30px;display:flex;flex-direction:column;gap:14px}
.gw-study-card.revealed{box-shadow:0 8px 28px rgba(20,32,27,.10)}
.gw-study-q{font-size:19px;font-weight:700;color:var(--ink,#14201B);line-height:1.4}
.gw-study-divider{height:1px;background:var(--hairline,#E7ECEA)}
.gw-study-a{font-size:16px;line-height:1.6;color:var(--ink,#14201B)}
.gw-study-reveal{align-self:center;padding:10px 28px}
.gw-study-grades{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}
.gw-grade{display:flex;flex-direction:column;align-items:center;gap:2px;min-width:96px;padding:9px 14px;border-radius:12px;border:1px solid var(--hairline,#E7ECEA);background:var(--surface,#fff);cursor:pointer;font-weight:700;color:var(--ink,#14201B)}
.gw-grade small{font-weight:500;font-size:10.5px;color:var(--muted,#5E6E67)}
.gw-grade:hover{transform:translateY(-1px)}
.gw-grade-again{border-color:#E7B7B7;background:#FCF2F2;color:#A8281F}
.gw-grade-hard{border-color:#EAD4B0;background:#FCF6EC}
.gw-grade-good{border-color:var(--mint-deep,#DCEFE5);background:var(--mint,#E8F5EE);color:var(--accent2,#0B7A57)}
.gw-grade-easy{border-color:#B9D9F0;background:#EFF6FC;color:#1F5FA8}
.gw-study-empty{display:flex;flex-direction:column;align-items:center;gap:14px;color:var(--muted,#5E6E67);text-align:center;margin-top:40px}
.gw-study-empty-icon{font-size:42px}
.gw-study-empty-msg{font-size:15px;color:var(--ink,#14201B)}
.gw-study-make{padding:10px 22px}
/* weaveNotes Phase 2 — translate card */
.gw-translate{display:flex;flex-direction:column;gap:12px;padding:18px 20px;min-width:340px}
.gw-translate-row{display:flex;flex-direction:column;gap:5px}
.gw-translate-label{font-size:13px;font-weight:600;color:var(--ink,#14201B)}
.gw-translate-lang,.gw-translate-tone{padding:9px 11px;border:1px solid var(--bg4);border-radius:9px;background:var(--bg1);font-size:14px;color:var(--ink,#14201B)}
.gw-translate-hint{font-size:12.5px;color:var(--muted,#5C6B63);margin:2px 0 0;line-height:1.5}
.gw-translate-error{font-size:13px;color:#b42318;margin:0}
.gw-translate-go{align-self:flex-start;padding:10px 22px;margin-top:4px}
/* weaveNotes Phase 2 — workspace governance card */
.gw-gov{display:flex;flex-direction:column;gap:10px;padding:18px 20px;min-width:440px;max-width:560px}
.gw-gov-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.gw-gov-title{font-size:15px;font-weight:700;color:var(--ink,#14201B)}
.gw-gov-score{font-size:12.5px;color:var(--muted,#5C6B63)}
.gw-gov-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.gw-gov-item{display:grid;grid-template-columns:20px 1fr auto;align-items:center;gap:8px;padding:6px 4px;border-bottom:1px solid var(--bg3,#eef2f0)}
.gw-gov-badge{font-weight:700;text-align:center}
.gw-gov-on .gw-gov-badge{color:#0a7d4e}
.gw-gov-off .gw-gov-badge{color:#9aa6a0}
.gw-gov-label{font-size:13.5px;color:var(--ink,#14201B)}
.gw-gov-detail{font-size:12px;color:var(--muted,#5C6B63);text-align:right}
.gw-gov-foot{font-size:11.5px;color:var(--muted,#5C6B63);margin:6px 0 0}
.gw-gov-loading,.gw-gov-empty{padding:24px;color:var(--muted,#5C6B63);font-size:13px}
/* weaveNotes Phase 3 — scheduled agents panel */
.gw-sched{display:flex;flex-direction:column;gap:12px;padding:18px 20px;min-width:480px;max-width:560px}
.gw-sched-intro{font-size:12.5px;color:var(--muted,#5C6B63);margin:0;line-height:1.5}
.gw-sched-empty{font-size:13px;color:var(--muted,#5C6B63);padding:8px 0}
.gw-sched-card{border:1px solid var(--bg4);border-radius:11px;padding:12px 14px;display:flex;flex-direction:column;gap:6px;background:var(--bg1)}
.gw-sched-card-head{display:flex;align-items:center;gap:8px}
.gw-sched-tag{font-size:11px;font-weight:600;color:#0a7d4e;background:#e7f6ee;border-radius:20px;padding:2px 9px}
.gw-sched-meta{font-size:12px;color:var(--muted,#5C6B63)}
.gw-sched-actions{display:flex;align-items:center;gap:10px;margin-top:2px}
.gw-sched-run{padding:6px 14px;font-size:13px}
.gw-sched-link{background:none;border:none;color:var(--muted,#5C6B63);font-size:12.5px;cursor:pointer;padding:4px 2px}
.gw-sched-link:hover{color:var(--ink,#14201B)}
.gw-sched-del:hover{color:#b42318}
.gw-sched-runs{display:flex;flex-direction:column;gap:2px;margin-top:2px}
.gw-sched-runs .gw-sched-run{padding:2px 0;font-size:11.5px;color:var(--muted,#5C6B63)}
.gw-sched-form{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--bg3,#eef2f0);padding-top:12px;margin-top:4px}
.gw-sched-form-title{font-size:13px;font-weight:700;color:var(--ink,#14201B)}
.gw-sched-input{padding:8px 11px;border:1px solid var(--bg4);border-radius:9px;background:var(--bg1);font-size:13.5px;color:var(--ink,#14201B)}
.gw-sched-lbl{font-size:11.5px;font-weight:600;color:var(--muted,#5C6B63);margin-bottom:-4px}
.gw-sched-create{align-self:flex-start;padding:9px 20px;margin-top:4px}
.gw-sched-error{font-size:13px;color:#b42318;margin:0}
/* weaveNotes Phase 3 — MCP connect panel */
.gw-mcp{display:flex;flex-direction:column;gap:12px;padding:18px 20px;min-width:480px;max-width:580px}
.gw-mcp-intro{font-size:12.5px;color:var(--muted,#5C6B63);margin:0;line-height:1.5}
.gw-mcp-endpoint{display:flex;align-items:center;gap:10px;font-size:12.5px}
.gw-mcp-endpoint code{background:var(--bg3,#eef2f0);border-radius:6px;padding:3px 8px;font-size:12px;word-break:break-all}
.gw-mcp-lbl{font-weight:600;color:var(--muted,#5C6B63)}
.gw-mcp-secret{border:1px solid #0a7d4e;background:#e7f6ee;border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:6px}
.gw-mcp-secret-title{font-size:12.5px;font-weight:700;color:#0a5d3a}
.gw-mcp-token{display:block;background:#fff;border:1px solid var(--bg4);border-radius:7px;padding:8px 10px;font-size:12.5px;word-break:break-all;user-select:all}
.gw-mcp-secret-hint{font-size:11.5px;color:var(--muted,#5C6B63)}
.gw-mcp-list{display:flex;flex-direction:column;gap:4px}
.gw-mcp-row{display:grid;grid-template-columns:1fr auto auto auto;align-items:center;gap:10px;padding:7px 4px;border-bottom:1px solid var(--bg3,#eef2f0)}
.gw-mcp-name{font-size:13.5px;font-weight:600;color:var(--ink,#14201B)}
.gw-mcp-scope{font-size:11px;color:#0a7d4e;background:#e7f6ee;border-radius:20px;padding:2px 9px}
.gw-mcp-pfx{font-size:11.5px;color:var(--muted,#5C6B63);font-family:monospace}
.gw-mcp-revoke{background:none;border:none;color:var(--muted,#5C6B63);font-size:12px;cursor:pointer}
.gw-mcp-revoke:hover{color:#b42318}
.gw-mcp-form{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--bg3,#eef2f0);padding-top:12px;margin-top:4px}
.gw-mcp-form-title{font-size:13px;font-weight:700;color:var(--ink,#14201B)}
.gw-mcp-input{padding:8px 11px;border:1px solid var(--bg4);border-radius:9px;background:var(--bg1);font-size:13.5px;color:var(--ink,#14201B)}
.gw-mcp-create{align-self:flex-start;padding:9px 20px;margin-top:4px}
.gw-mcp-error{font-size:13px;color:#b42318;margin:0}
.gw-mcp-foot{font-size:11.5px;color:var(--muted,#5C6B63);margin:6px 0 0;line-height:1.5}
/* Slash menu */
.notes-slash-menu{background:var(--bg1);border:1px solid var(--bg4);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.15);padding:4px;min-width:200px;z-index:300}
.notes-slash-item{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:6px;cursor:pointer;font-size:13px;color:var(--fg1)}
.notes-slash-item:hover{background:var(--bg2)}
.notes-slash-icon{font-size:13px;font-weight:700;color:var(--fg2);width:22px;text-align:center;flex-shrink:0}
.notes-slash-empty{padding:10px;font-size:12px;color:var(--fg3);text-align:center}
/* Error / prompt states */
.notes-editor-error{padding:16px;color:#dc2626;background:#fef2f2;border-radius:8px;font-size:13px}
.notes-select-prompt{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:8px;color:var(--fg3)}
.notes-select-icon{font-size:40px}
.notes-select-msg{font-size:16px;font-weight:600;color:var(--fg2)}
.notes-select-sub{font-size:13px}

.sv-hidden{display:none!important}
/* ── Scientific Validation Submit ──────────────────────── */
.sv-page{max-width:880px;margin:0 auto;padding-bottom:60px}
.sv-page-header{display:flex;align-items:center;gap:14px;margin-bottom:28px}
.sv-page-icon{width:48px;height:48px;border-radius:14px;background:var(--accent-dim);display:flex;align-items:center;justify-content:center;font-size:24px;flex-shrink:0}
.sv-page-title{font-size:24px;font-weight:800;color:var(--fg);margin:0 0 4px}
.sv-page-sub{color:var(--fg3);font-size:14px;margin:0}
.sv-tips-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:22px}
.sv-tip-card{padding:12px 14px;border-radius:10px;background:var(--bg2);border:1px solid var(--bg4);display:flex;flex-direction:column;gap:4px}
.sv-tip-head{display:flex;align-items:center;gap:7px}
.sv-tip-icon{font-size:16px;line-height:1}
.sv-tip-title{font-size:13px;font-weight:700;color:var(--fg)}
.sv-tip-body{font-size:12px;color:var(--fg3);line-height:1.45;margin-top:2px}
.sv-section-title{font-size:13px;font-weight:700;color:var(--fg2);margin-bottom:12px}
.sv-tpl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin-bottom:24px}
.sv-tpl-card{padding:14px 16px;border-radius:12px;border:2px solid var(--bg4);background:var(--bg2);cursor:pointer;display:flex;flex-direction:column;gap:6px;transition:border-color .18s,background .18s}
.sv-tpl-card:hover{border-color:var(--accent);background:var(--accent-dim)}
.sv-tpl-card.sv-active{border-color:var(--accent);background:var(--accent-dim)}
.sv-tpl-head{display:flex;align-items:center;justify-content:space-between}
.sv-tpl-icon{font-size:20px;line-height:1}
.sv-tpl-badge{font-size:9px;font-weight:700;padding:2px 7px;border-radius:999px;background:var(--accent);color:white;text-transform:uppercase;letter-spacing:.05em}
.sv-tpl-name{font-size:13px;font-weight:700;color:var(--fg)}
.sv-tpl-name.sv-active{color:var(--accent)}
.sv-tpl-cat{font-size:11px;color:var(--fg3)}
.sv-form-card{background:var(--bg2);border:1px solid var(--bg4);border-radius:16px;padding:28px 32px}
.sv-form-head{font-size:16px;font-weight:700;color:var(--fg);margin-bottom:22px;display:flex;align-items:center;gap:8px}
.sv-form-head-icon{font-size:18px}
.sv-form-sec{margin-bottom:20px}
.sv-label{font-size:13px;font-weight:700;color:var(--fg2);margin-bottom:2px}
.sv-label-hint{font-size:11px;color:var(--fg3);margin-bottom:8px}
.sv-field{width:100%;padding:13px 16px;border-radius:10px;border:1.5px solid var(--bg4);background:var(--bg);color:var(--fg);font-size:15px;font-weight:500;box-sizing:border-box;font-family:inherit;transition:border-color .18s}
.sv-field:focus{outline:none;border-color:var(--accent)}
.sv-textarea{width:100%;padding:13px 16px;border-radius:10px;border:1.5px solid var(--bg4);background:var(--bg);color:var(--fg);font-size:14px;resize:vertical;line-height:1.6;box-sizing:border-box;font-family:inherit;min-height:180px;transition:border-color .18s}
.sv-textarea:focus{outline:none;border-color:var(--accent)}
.sv-tag-input{width:100%;padding:9px 13px;border-radius:8px;border:1.5px solid var(--bg4);background:var(--bg);color:var(--fg);font-size:13px;box-sizing:border-box;font-family:inherit;transition:border-color .18s}
.sv-tag-input:focus{outline:none;border-color:var(--accent)}
.sv-char-count{font-size:11px;color:var(--fg3);text-align:right;margin-top:4px}
.sv-char-count.sv-warn{color:var(--warn)}
.sv-chips-row{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;min-height:4px}
.sv-chip{display:inline-flex;align-items:center;gap:5px;padding:4px 11px;border-radius:999px;background:var(--accent-dim);border:1px solid var(--accent);color:var(--accent);font-size:12px;font-weight:600}
.sv-chip-remove{font-size:14px;line-height:1;color:var(--accent);padding:0 0 0 2px;background:none;border:none;cursor:pointer}
.sv-sugg-label{font-size:11px;color:var(--fg3);margin:10px 0 6px}
.sv-sugg-row{display:flex;flex-wrap:wrap;gap:6px}
.sv-sugg-btn{padding:4px 12px;border-radius:999px;border:1px solid var(--bg4);background:var(--bg3);color:var(--fg3);font-size:12px;cursor:pointer;white-space:nowrap;transition:border-color .15s,color .15s,background .15s}
.sv-sugg-btn:hover{border-color:var(--accent);color:var(--accent);background:var(--accent-dim)}
.sv-error{display:none;padding:10px 14px;border-radius:9px;background:rgba(220,38,38,.09);border:1px solid rgba(220,38,38,.25);color:var(--danger);font-size:13px;margin-bottom:14px}
.sv-error.sv-show{display:block}
.sv-submit-row{display:flex;justify-content:flex-end;margin-top:8px}
.sv-submit-btn{padding:13px 36px;border-radius:999px;background:var(--solid);color:white;font-size:15px;font-weight:700;cursor:pointer;border:none;transition:opacity .18s}
.sv-submit-btn:hover{opacity:.88}
.sv-submit-btn:disabled{opacity:.5;cursor:default}
.sv-recent-wrap{background:var(--bg2);border:1px solid var(--bg4);border-radius:12px;padding:14px 18px;margin-bottom:20px}
.sv-recent-head{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--fg3);margin-bottom:10px}
.sv-recent-list{display:flex;flex-direction:column;gap:5px}
.sv-recent-row{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:8px;background:var(--bg);border:1px solid var(--bg4);cursor:pointer;transition:background .15s}
.sv-recent-row:hover{background:var(--bg3)}
.sv-recent-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;display:inline-block}
.sv-recent-title{font-size:13px;color:var(--fg);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sv-recent-status{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;flex-shrink:0}
.sv-recent-arr{font-size:11px;flex-shrink:0}
.sv-dot-running{background:#f59e0b}.sv-dot-queued{background:#6366f1}.sv-dot-verdict{background:#059669}.sv-dot-abandoned{background:#6b7280}
.sv-status-running{color:#f59e0b}.sv-status-queued{color:#6366f1}.sv-status-verdict{color:#059669}.sv-status-abandoned{color:#6b7280}
/* ── SV Agent / Kind Colours ─────────────────────────────── */
.sv-color-decomposer{color:#6366f1}.sv-color-literature{color:#0ea5e9}.sv-color-statistical{color:#8b5cf6}.sv-color-mathematical{color:#d97706}.sv-color-simulation{color:#14b8a6}.sv-color-adversarial{color:#ef4444}.sv-color-supervisor{color:#059669}.sv-color-unknown{color:#6b7280}
.sv-bg-decomposer{background:#6366f118;border-color:#6366f1}.sv-bg-literature{background:#0ea5e918;border-color:#0ea5e9}.sv-bg-statistical{background:#8b5cf618;border-color:#8b5cf6}.sv-bg-mathematical{background:#d9770618;border-color:#d97706}.sv-bg-simulation{background:#14b8a618;border-color:#14b8a6}.sv-bg-adversarial{background:#ef444418;border-color:#ef4444}.sv-bg-supervisor{background:#05966918;border-color:#059669}.sv-bg-unknown{background:#6b728018;border-color:#6b7280}
.sv-kp{font-size:10px;font-weight:700;color:white;border-radius:4px;padding:2px 7px;letter-spacing:.04em;text-transform:uppercase;flex-shrink:0}
.sv-kp-tool-call{background:#0ea5e9}.sv-kp-tool-error{background:#ef4444}.sv-kp-model-inference{background:#8b5cf6}.sv-kp-supports{background:#059669}.sv-kp-refutes{background:#ef4444}.sv-kp-neutral{background:#6b7280}.sv-kp-inconclusive{background:#d97706}.sv-kp-default{background:#6b7280}
/* ── SV Live View ────────────────────────────────────────── */
.sv-live-pg{max-width:960px;margin:0 auto;padding-bottom:48px}
.sv-live-header{display:flex;align-items:flex-start;gap:14px;margin-bottom:20px;flex-wrap:wrap}
.sv-live-icon{width:44px;height:44px;border-radius:12px;background:var(--accent-dim);display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0}
.sv-live-hyp{flex:1;min-width:200px}
.sv-live-hyp-title{font-size:17px;font-weight:700;color:var(--fg);margin-bottom:4px}
.sv-live-hyp-stmt{font-size:12px;color:var(--fg3);line-height:1.5;max-height:56px;overflow:hidden}
.sv-live-hyp-tags{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px}
.sv-live-tag{font-size:10px;font-weight:600;padding:2px 8px;border-radius:999px;background:var(--accent-dim);color:var(--accent);border:1px solid var(--accent)}
.sv-live-ctrl{display:flex;flex-direction:column;align-items:flex-end;gap:8px;flex-shrink:0}
.sv-live-meta{display:flex;align-items:center;gap:8px}
.sv-live-status{font-size:12px;color:var(--fg3)}
.sv-live-sep{color:var(--fg3)}
.sv-live-elapsed{font-size:12px;color:var(--fg3);font-variant-numeric:tabular-nums}
.sv-live-btns{display:flex;gap:7px}
.sv-live-cancel-btn{padding:6px 14px;border-radius:8px;border:1px solid rgba(220,38,38,.4);background:transparent;color:var(--danger);font-size:13px;font-weight:600;cursor:pointer;transition:background .15s}
.sv-live-cancel-btn:hover{background:rgba(220,38,38,.08)}
.sv-live-back-btn{padding:6px 14px;border-radius:8px;border:1px solid var(--bg4);background:transparent;color:var(--fg2);font-size:13px;font-weight:600;cursor:pointer;transition:background .15s}
.sv-live-back-btn:hover{background:var(--bg3)}
.sv-live-agents{background:var(--bg2);border:1px solid var(--bg4);border-radius:12px;padding:12px 16px;margin-bottom:18px}
.sv-live-agents-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--fg3);margin-bottom:8px}
.sv-live-pills{display:flex;flex-wrap:wrap;gap:6px}
.sv-live-pill{display:flex;align-items:center;gap:5px;padding:4px 10px;border-radius:999px;border:1px solid var(--bg4);background:transparent;transition:all .3s}
.sv-live-pill.sv-active{background:var(--accent-dim);border-color:var(--accent)}
.sv-live-pill-emoji{font-size:12px}
.sv-live-pill-name{font-size:11px;font-weight:600;color:var(--fg3)}
.sv-live-pill.sv-active .sv-live-pill-name{color:var(--accent)}
.sv-live-pill-dot{width:6px;height:6px;border-radius:50%;background:var(--accent);animation:sv-pulse 1.2s ease-in-out infinite;flex-shrink:0}
.sv-live-cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.sv-live-panel{background:var(--bg2);border:1px solid var(--bg4);border-radius:12px;display:flex;flex-direction:column;overflow:hidden}
.sv-live-panel-head{padding:10px 14px;border-bottom:1px solid var(--bg4);display:flex;align-items:center;justify-content:space-between}
.sv-live-panel-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--fg3)}
.sv-live-panel-count{font-size:11px;color:var(--fg3)}
.sv-live-panel-body{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;max-height:480px}
.sv-live-ev{display:flex;gap:10px;align-items:flex-start;background:var(--bg);border:1px solid var(--bg4);border-radius:10px;padding:10px 13px;animation:sv-fadein .25s ease-out}
.sv-live-ev-av{width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;border:1px solid transparent}
.sv-live-ev-body{flex:1;min-width:0}
.sv-live-ev-meta{display:flex;align-items:center;gap:7px;margin-bottom:4px;flex-wrap:wrap}
.sv-live-ev-name{font-size:12px;font-weight:700}
.sv-live-ev-role{font-size:10px;color:var(--fg3)}
.sv-live-ev-tool{font-size:10px;color:var(--fg3);font-family:var(--mono);background:var(--bg3);padding:1px 6px;border-radius:4px;border:1px solid var(--bg4)}
.sv-live-ev-text{font-size:12px;color:var(--fg);line-height:1.5}
.sv-live-turn{display:flex;gap:9px;align-items:flex-start;background:var(--bg);border:1px solid var(--bg4);border-radius:10px;padding:9px 12px;animation:sv-fadein .25s ease-out}
.sv-live-turn.sv-dissent{background:rgba(239,68,68,.06);border-color:rgba(239,68,68,.25)}
.sv-live-turn-av{width:28px;height:28px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;border:1px solid transparent}
.sv-live-turn-body{flex:1;min-width:0}
.sv-live-turn-meta{display:flex;align-items:center;gap:6px;margin-bottom:3px;flex-wrap:wrap}
.sv-live-turn-name{font-size:12px;font-weight:700}
.sv-live-turn-to{font-size:10px;color:var(--fg3)}
.sv-live-turn-round{font-size:10px;color:var(--fg3)}
.sv-live-turn-dissent{font-size:10px;font-weight:700;color:var(--danger);background:rgba(239,68,68,.1);padding:1px 6px;border-radius:4px}
.sv-live-turn-msg{font-size:12px;color:var(--fg);line-height:1.5;white-space:pre-wrap;word-break:break-word}
.sv-live-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:28px 0;gap:10px}
.sv-live-spinner{width:36px;height:36px;border-radius:50%;border:3px solid var(--bg4);border-top-color:var(--accent);animation:sv-spin 1s linear infinite}
.sv-live-empty-text{font-size:12px;color:var(--fg3)}
/* ── SV Verdict View ─────────────────────────────────────── */
.sv-vd-pg{max-width:860px;margin:0 auto;padding-bottom:48px}
.sv-vd-topbar{display:flex;align-items:center;gap:12px;margin-bottom:22px}
.sv-vd-topbar-icon{width:40px;height:40px;border-radius:10px;background:var(--accent-dim);display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0}
.sv-vd-topbar-text{flex:1;min-width:0}
.sv-vd-topbar-title{font-size:20px;font-weight:800;color:var(--fg);margin:0 0 2px}
.sv-vd-topbar-sub{font-size:12px;color:var(--fg3)}
.sv-vd-topbar-btns{display:flex;gap:8px;flex-shrink:0}
.sv-vd-hero{border:2px solid transparent;border-radius:16px;padding:24px 28px;margin-bottom:16px}
.sv-vd-hero-supported{background:rgba(5,150,105,.1);border-color:rgba(5,150,105,.4)}
.sv-vd-hero-refuted{background:rgba(220,38,38,.1);border-color:rgba(220,38,38,.4)}
.sv-vd-hero-inconclusive{background:rgba(217,119,6,.1);border-color:rgba(217,119,6,.4)}
.sv-vd-hero-ill-posed{background:rgba(124,58,237,.1);border-color:rgba(124,58,237,.4)}
.sv-vd-hero-out-of-scope{background:rgba(107,114,128,.1);border-color:rgba(107,114,128,.4)}
.sv-vd-hero-row{display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap}
.sv-vd-vleft{display:flex;align-items:center;gap:12px;flex:1;min-width:200px}
.sv-vd-vicon{font-size:36px;flex-shrink:0}
.sv-vd-vlabel{font-size:24px;font-weight:900}
.sv-vd-text-supported{color:#059669}.sv-vd-text-refuted{color:#dc2626}.sv-vd-text-inconclusive{color:#d97706}.sv-vd-text-ill-posed{color:#7c3aed}.sv-vd-text-out-of-scope{color:#6b7280}
.sv-vd-badges{display:flex;align-items:center;gap:8px;margin-top:4px;flex-wrap:wrap}
.sv-vd-grade{font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;border:1px solid}
.sv-grade-high{color:#059669;background:rgba(5,150,105,.15);border-color:#059669}.sv-grade-moderate{color:#d97706;background:rgba(217,119,6,.15);border-color:#d97706}.sv-grade-low{color:#ef4444;background:rgba(239,68,68,.15);border-color:#ef4444}.sv-grade-very-low{color:#dc2626;background:rgba(220,38,38,.15);border-color:#dc2626}
.sv-vd-bh{font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;background:rgba(99,102,241,.15);color:#6366f1;border:1px solid #6366f1}
.sv-vd-emitted{font-size:11px;color:var(--fg3)}
.sv-vd-ci-side{min-width:200px;flex:1}
.sv-vd-ci-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--fg3);margin-bottom:4px;margin-top:6px}
.sv-vd-ci-svg{display:block;width:100%;height:8px;margin-top:6px;overflow:visible}
.sv-vd-ci-track{fill:var(--bg4)}
.sv-vd-ci-nums{display:flex;justify-content:space-between;font-size:11px;color:var(--fg3);margin-top:3px}
.sv-vd-summary{margin-top:16px;font-size:13px;color:var(--fg);line-height:1.6;background:rgba(0,0,0,.05);border-radius:8px;padding:12px 14px}
.sv-vd-sec{background:var(--bg2);border:1px solid var(--bg4);border-radius:12px;padding:18px 20px;margin-bottom:14px}
.sv-vd-sec-title{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--fg3);margin-bottom:12px}
.sv-vd-hyp-stmt{font-size:13px;color:var(--fg);line-height:1.6}
.sv-vd-hyp-tags{display:flex;gap:5px;flex-wrap:wrap;margin-top:8px}
.sv-vd-hyp-tag{font-size:10px;padding:2px 8px;border-radius:999px;background:var(--accent-dim);color:var(--accent);border:1px solid var(--accent)}
.sv-vd-subclaims{display:flex;flex-direction:column;gap:8px}
.sv-vd-sc{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:9px;background:var(--bg);border:1px solid var(--bg4)}
.sv-vd-sc-icon{font-size:16px;flex-shrink:0;margin-top:1px}
.sv-vd-sc-body{flex:1;min-width:0}
.sv-vd-sc-meta{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:3px}
.sv-vd-sc-stmt{font-size:12px;color:var(--fg2);line-height:1.5}
.sv-vd-vpill{font-size:11px;font-weight:700;padding:2px 9px;border-radius:999px;border:1px solid}
.sv-vp-supported{background:rgba(5,150,105,.1);color:#059669;border-color:#059669}.sv-vp-refuted{background:rgba(220,38,38,.1);color:#dc2626;border-color:#dc2626}.sv-vp-inconclusive{background:rgba(217,119,6,.1);color:#d97706;border-color:#d97706}
.sv-vd-sw-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px}
.sv-vd-strengths{background:rgba(5,150,105,.07);border:1px solid rgba(5,150,105,.2);border-radius:12px;padding:14px 16px}
.sv-vd-weaknesses{background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.2);border-radius:12px;padding:14px 16px}
.sv-vd-sw-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px}
.sv-vd-s-title{color:#059669}.sv-vd-w-title{color:#ef4444}
.sv-vd-sw-list{display:flex;flex-direction:column;gap:5px;padding:0;list-style:none}
.sv-vd-sw-item{display:flex;gap:6px;font-size:12px;color:var(--fg2);line-height:1.45}
.sv-vd-s-dot{flex-shrink:0;color:#059669;margin-top:1px}.sv-vd-w-dot{flex-shrink:0;color:#ef4444;margin-top:1px}
.sv-vd-steps{display:flex;flex-direction:column;gap:7px;padding:0;list-style:none}
.sv-vd-step{display:flex;gap:10px;align-items:flex-start;font-size:13px;color:var(--fg2);line-height:1.5}
.sv-vd-step-num{width:22px;height:22px;border-radius:50%;background:var(--accent-dim);color:var(--accent);font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.sv-vd-evlist{display:flex;flex-direction:column;gap:6px}
.sv-vd-ev{display:flex;gap:9px;align-items:flex-start;padding:8px 10px;background:var(--bg);border:1px solid var(--bg4);border-radius:8px}
.sv-vd-ev-icon{font-size:13px;flex-shrink:0;margin-top:1px}
.sv-vd-ev-body{flex:1;min-width:0}
.sv-vd-ev-meta{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:2px}
.sv-vd-ev-agent{font-size:11px;font-weight:600;color:var(--fg2)}
.sv-vd-ev-kind{font-size:10px;padding:1px 6px;border-radius:4px;background:var(--bg3);color:var(--fg3);border:1px solid var(--bg4)}
.sv-vd-ev-tool{font-size:10px;font-family:var(--mono);color:var(--fg3)}
.sv-vd-ev-text{font-size:12px;color:var(--fg2);line-height:1.45}
.sv-vd-extra{font-size:12px;color:var(--fg3);text-align:center;padding:6px}
.sv-vd-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:8px}
.sv-vd-dl-link{text-decoration:none}
.sv-vd-error{background:rgba(220,38,38,.08);border:1px solid rgba(220,38,38,.2);border-radius:10px;padding:14px 16px;color:var(--danger);font-size:13px}
.sv-vd-loading{color:var(--fg3);font-size:13px;text-align:center;padding:40px 0}
/* ── SV Keyframe Animations ──────────────────────────────── */
@keyframes sv-pulse{0%,100%{opacity:.4;transform:scale(.9)}50%{opacity:1;transform:scale(1.1)}}
@keyframes sv-spin{to{transform:rotate(360deg)}}
@keyframes sv-fadein{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}

/* ── Scrollbar ────────────────────────────– */
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--bg4);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:var(--fg3)}

@media(max-width:1100px){.workspace-body{grid-template-columns:1fr}.right-rail{display:none}}
@media(max-width:900px){.charts{grid-template-columns:1fr}.workspace-nav{width:78px}}
@media(max-width:900px){.prompt-wizard-grid{grid-template-columns:1fr}}
@media(max-width:1200px){.admin-content-grid.editing{grid-template-columns:minmax(0,1fr)}}
@media(max-width:1200px){.admin-editor-panel{position:static}}
@media(max-width:900px){.cal-week-view .cal-week-header,.cal-week-grid .cal-week-row{grid-template-columns:40px repeat(7,1fr)}}

/* ── geneWeave responsive adaptive shell (web · tablet · mobile) ───────────────────────
   Rails are persistent side panels on desktop and become off-canvas DRAWERS below tablet
   (slide over, close on backdrop-tap / Esc), so the whole app stays navigable on a phone.
   Breakpoints come from @weaveintel/tokens: tablet 900, desktop 1200. */
.gw-hamburger{display:none;align-items:center;justify-content:center;width:40px;height:40px;border-radius:10px;border:1px solid var(--bg4);background:var(--bg2);color:var(--fg);cursor:pointer;flex:none}
.nav-backdrop{display:none;position:fixed;inset:0;background:rgba(20,32,27,.32);z-index:150;opacity:0;pointer-events:none;transition:opacity .2s ease}
@media(max-width:899.98px){
  .app{position:relative;flex-direction:row}
  .app > .workspace-nav{position:fixed;top:0;left:0;bottom:0;height:100vh;max-height:100vh;z-index:200;width:min(86vw,320px);transform:translateX(-100%);transition:transform .22s ease;box-shadow:var(--shadow-pop)}
  .app.nav-open > .workspace-nav{transform:translateX(0)}
  .app .nav-backdrop{display:block}
  .app.nav-open .nav-backdrop{opacity:1;pointer-events:auto}
  .app .gw-hamburger{display:inline-flex}
  .main{width:100%;min-width:0}
  .notes-layout{grid-template-columns:1fr}
  /* Notes notebook rail → slide-over drawer, reachable via its toggle instead of vanishing. */
  .app-fullbleed .notes-sidebar{position:fixed;top:0;left:0;bottom:0;z-index:200;width:min(86vw,320px);transform:translateX(-100%);transition:transform .22s ease;box-shadow:var(--shadow-pop);background:var(--bg2);display:flex}
  .app-fullbleed.rail-open .notes-sidebar{transform:translateX(0)}
  .app-fullbleed .gw-left-rail{display:flex}
}
@media(prefers-reduced-motion:reduce){.app > .workspace-nav,.nav-backdrop,.app-fullbleed .notes-sidebar{transition:none}}

/* ============================================================================================
   Account settings surface — "GeneWeave Account.dc.html". A 256px nav + centred content + sticky
   Save bar. All colours flow from --gw-* / legacy tokens so light, dark and re-brand all work.
   ============================================================================================ */
.acct-app{display:flex;height:100%;background:var(--canvas);color:var(--ink);font-family:var(--font);position:relative;overflow:hidden}
/* nav */
.acct-nav{width:256px;flex:none;background:var(--surface);border-right:1px solid var(--hairline);display:flex;flex-direction:column}
.acct-nav-head{display:flex;align-items:center;gap:10px;padding:16px 16px 14px;border-bottom:1px solid var(--hairline)}
.acct-nav-mark{display:inline-flex;flex:none}
.acct-nav-word{font-family:var(--font-display);font-size:15px;font-weight:700;letter-spacing:-0.02em;line-height:1.1}
.acct-nav-eyebrow{font-family:var(--mono);font-size:10px;letter-spacing:0.12em;color:var(--accent);margin-top:2px}
.acct-nav-body{flex:1;overflow-y:auto;padding:14px 12px;display:flex;flex-direction:column;gap:18px}
.acct-nav-group{display:flex;flex-direction:column;gap:3px}
.acct-nav-grouplabel{font-family:var(--mono);font-size:10px;letter-spacing:0.1em;color:var(--fg3);padding:2px 10px 4px}
.acct-nav-item{display:flex;align-items:center;gap:11px;padding:9px 11px;border-radius:10px;font-size:13.5px;cursor:pointer;color:var(--fg2)}
.acct-nav-item:hover{background:var(--bg3)}
.acct-nav-item.active{background:var(--mint);color:var(--accent2);font-weight:600}
.acct-nav-ic{display:flex;flex:none;color:inherit}
.acct-nav-badge{font-size:10px;font-weight:600;color:var(--coral);background:var(--diff-del-bg);border-radius:999px;padding:1px 7px}
.acct-nav-foot{border-top:1px solid var(--hairline);padding:12px}
.acct-user-card{display:flex;align-items:center;gap:11px;padding:8px 9px;border-radius:11px;background:var(--canvas)}
.acct-user-avatar{width:34px;height:34px;border-radius:50%;background:var(--solid);color:var(--solid-contrast);display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;flex:none}
.acct-user-name{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.acct-user-org{font-size:11px;color:var(--fg3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.acct-nav-back{width:26px;height:26px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;color:var(--fg3);cursor:pointer;flex:none}
.acct-nav-back:hover{background:var(--bg3);color:var(--fg2)}
/* main + content */
.acct-main{flex:1;min-width:0;overflow-y:auto}
.acct-content{max-width:760px;margin:0 auto;padding:38px 40px 110px;display:flex;flex-direction:column;gap:30px}
.acct-header{display:flex;flex-direction:column;gap:6px}
.acct-eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:0.1em;color:var(--accent)}
.acct-title{font-family:var(--font-display);font-size:28px;font-weight:800;letter-spacing:-0.025em;margin:0}
.acct-desc{font-size:14px;line-height:1.6;color:var(--fg2);margin:0}
/* cards + rows */
.acct-card{background:var(--surface);border:1px solid var(--hairline);border-radius:14px;padding:18px}
.acct-rowlist{padding:6px 18px}
.acct-row{display:flex;align-items:center;gap:14px;padding:15px 0;border-bottom:1px solid var(--bg3)}
.acct-row.last{border-bottom:none}
.acct-row-title{font-size:14px;font-weight:600;color:var(--fg)}
.acct-row-sub{font-size:12.5px;color:var(--fg2);margin-top:2px}
.acct-subhead{font-family:var(--mono);font-size:11px;letter-spacing:0.08em;color:var(--accent);padding-left:2px;margin-bottom:11px}
.acct-grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.acct-field{display:flex;flex-direction:column;gap:7px}
.acct-field.full{grid-column:1 / -1}
.acct-label{font-size:13px;font-weight:600;color:var(--fg)}
.acct-input,.acct-textarea,.acct-select{font-family:inherit;font-size:14px;color:var(--fg);background:var(--surface);border:1px solid var(--hairline);border-radius:10px;padding:11px 13px;outline:none;width:100%}
.acct-textarea{line-height:1.6;resize:vertical}
.acct-input:focus,.acct-textarea:focus,.acct-select:focus{border-color:var(--accent)}
.acct-select{cursor:pointer;max-width:230px}
/* pills + buttons */
.acct-pill{font-size:11px;font-weight:600;border-radius:999px;padding:3px 10px;white-space:nowrap;flex:none}
.acct-pill.ok{color:var(--accent2);background:var(--mint)}
.acct-pill.warn{color:var(--danger-zone-fg);background:var(--danger-zone-bg)}
.acct-pill.muted{color:var(--fg2);background:var(--bg3)}
.acct-btn-ghost{font-size:13px;font-weight:600;color:var(--fg2);background:var(--surface);border:1px solid var(--hairline);border-radius:9px;padding:8px 14px;cursor:pointer;flex:none}
.acct-btn-ghost:hover:not([disabled]){background:var(--bg3)}
.acct-btn-ghost[disabled]{opacity:.5;cursor:default}
.acct-btn-emerald{font-size:13px;font-weight:600;color:#fff;background:var(--accent);border:none;border-radius:999px;padding:9px 16px;cursor:pointer;display:inline-flex;align-items:center;gap:7px;flex:none}
.acct-btn-emerald[disabled]{opacity:.5;cursor:default}
.acct-btn-danger-ghost{font-size:13px;font-weight:600;color:var(--danger-zone-fg);background:var(--surface);border:1px solid var(--danger-zone-border);border-radius:9px;padding:9px 15px;cursor:pointer}
/* profile band */
.acct-profile-band{display:flex;gap:20px;align-items:center;border-radius:16px;padding:22px}
.acct-avatar-lg{width:76px;height:76px;border-radius:50%;background:linear-gradient(135deg,#14201B,#2F6E5B);color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:28px;font-weight:700;font-family:var(--font-display);flex:none}
.acct-profile-name{font-family:var(--font-display);font-size:20px;font-weight:700;letter-spacing:-0.01em}
.acct-profile-role{font-size:13px;color:var(--fg2);margin-top:3px}
.acct-profile-status{display:flex;align-items:center;gap:8px;margin-top:10px;font-size:12px;color:var(--fg)}
.acct-status-dot{width:8px;height:8px;border-radius:50%;background:var(--accent)}
/* theme cards */
.acct-theme-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.acct-theme-card{border:1.5px solid var(--hairline);border-radius:13px;padding:13px;display:flex;flex-direction:column;gap:11px;cursor:pointer;background:var(--surface)}
.acct-theme-card.active{border-color:var(--accent);box-shadow:0 0 0 3px var(--mint)}
.acct-theme-swatch{height:56px;border-radius:9px;display:flex;align-items:center;padding:0 12px}
.acct-theme-swatch.pro{background:var(--surface);border:1px solid var(--hairline)}
.acct-theme-swatch.creative{background:var(--paper);border:1px solid #ECE4D5}
.acct-theme-bar{border-radius:3px}
.acct-theme-bar.dark{width:34px;height:6px;background:var(--ink)}
.acct-theme-bar.gold{width:34px;height:8px;background:#C9942E}
.acct-theme-radio{width:16px;height:16px;border-radius:50%;flex:none;border:2px solid var(--fg3);background:var(--surface)}
.acct-theme-radio.on{border-color:var(--accent);background:radial-gradient(circle,var(--accent) 0 42%,var(--surface) 46%)}
/* notifications matrix */
.acct-notif{padding:0;overflow:hidden}
.acct-notif-head{display:grid;grid-template-columns:1fr 66px 66px 66px;gap:0;padding:13px 18px;border-bottom:1px solid var(--hairline);background:var(--canvas);font-family:var(--mono);font-size:10px;letter-spacing:0.06em;color:var(--fg3)}
.acct-notif-row{display:grid;grid-template-columns:1fr 66px 66px 66px;gap:0;align-items:center;padding:14px 18px;border-bottom:1px solid var(--bg3)}
.acct-notif-row.last{border-bottom:none}
.acct-toggle{width:34px;height:20px;border-radius:999px;border:none;background:var(--bg4);cursor:pointer;position:relative;flex:none;padding:0;transition:background .16s ease}
.acct-toggle.on{background:var(--accent)}
.acct-toggle-knob{position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:#fff;transition:transform .16s ease}
.acct-toggle.on .acct-toggle-knob{transform:translateX(14px)}
/* people */
.acct-search{flex:1;display:flex;align-items:center;gap:9px;background:var(--surface);border:1px solid var(--hairline);border-radius:10px;padding:9px 13px;font-size:13px;color:var(--fg3)}
.acct-search-ic{display:flex;color:var(--fg3)}
.acct-member-av{width:34px;height:34px;border-radius:50%;flex:none;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;color:#fff;background:var(--solid)}
.acct-role-chip{font-size:13px;color:var(--fg2);display:inline-flex;align-items:center;gap:6px;background:var(--canvas);border:1px solid var(--hairline);border-radius:8px;padding:6px 11px}
/* m143 — admin-editable member role dropdown in the People view. */
.acct-role-select{font-size:13px;color:var(--fg1);background:var(--canvas);border:1px solid var(--hairline);border-radius:8px;padding:6px 10px;font-family:var(--font);cursor:pointer}
.acct-role-select:hover{border-color:var(--fg3)}
/* admin */
.acct-admin-card{background:var(--surface);border:1px solid var(--hairline);border-radius:14px;padding:17px;display:flex;flex-direction:column;gap:9px}
.acct-admin-ic{width:32px;height:32px;border-radius:9px;background:var(--mint);color:var(--accent2);display:flex;align-items:center;justify-content:center;flex:none}
.acct-admin-cta{font-size:13px;font-weight:600;color:var(--accent2);cursor:pointer}
/* billing */
.acct-plan-card{background:linear-gradient(120deg,#14201B,#22332C);border-radius:16px;padding:22px;color:#fff;display:flex;align-items:center;gap:20px}
.acct-plan-eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:0.08em;color:#7FB7A0}
.acct-plan-name{font-family:var(--font-display);font-size:24px;font-weight:800;letter-spacing:-0.02em;margin-top:4px}
.acct-plan-sub{font-size:13px;color:#B9C7C1;margin-top:3px}
.acct-plan-btn{font-size:13px;font-weight:600;color:#14201B;background:#fff;border:none;border-radius:9px;padding:9px 16px;cursor:pointer}
.acct-usage-bar{height:8px;border-radius:999px;background:var(--bg3);overflow:hidden;margin-top:10px}
.acct-usage-fill{height:100%;border-radius:999px;background:var(--accent)}
.acct-ic{display:inline-flex}
/* sticky save bar */
.acct-savebar{position:absolute;bottom:0;left:256px;right:0;background:color-mix(in srgb,var(--surface) 92%,transparent);backdrop-filter:blur(6px);border-top:1px solid var(--hairline);padding:12px 40px;display:flex;align-items:center;justify-content:space-between;gap:10px}
.acct-savebar-status{font-size:12px;color:var(--fg3)}
.acct-savebar.dirty .acct-savebar-status{color:var(--amber)}
.acct-savebar-actions{display:flex;gap:10px;margin-left:auto}
/* responsive: nav → top row, single-column content, save bar spans full width */
@media(max-width:899.98px){
  .acct-app{flex-direction:column;overflow-y:auto}
  .acct-nav{width:100%;flex-direction:row;flex-wrap:wrap;border-right:none;border-bottom:1px solid var(--hairline)}
  .acct-nav-head{width:100%}
  .acct-nav-body{flex-direction:row;flex-wrap:wrap;gap:8px;padding:10px 12px}
  .acct-nav-group{flex-direction:row;flex-wrap:wrap;align-items:center;gap:4px}
  .acct-nav-grouplabel{display:none}
  .acct-nav-foot{display:none}
  .acct-content{padding:24px 18px 120px;gap:22px}
  .acct-grid2,.acct-theme-grid{grid-template-columns:1fr}
  .acct-savebar{left:0}
}
`;
