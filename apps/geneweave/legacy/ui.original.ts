/**
 * @weaveintel/geneweave — Embedded web UI
 *
 * Returns the full SPA HTML as a string. The UI includes:
 *  - Auth screens (login / register)
 *  - Chat interface with streaming & sidebar
 *  - Dashboard with metrics, cost, latency & eval charts
 *
 * Everything is self-contained — no CDN, no build step, no external assets.
 */

import { ADMIN_TAB_GROUPS, ADMIN_TABS } from './admin-schema.js';

export function getHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>geneWeave — AI Chat &amp; Observability</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@500;700&family=JetBrains+Mono:wght@400;500&family=Fira+Code:wght@400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#EDF5F0;--bg2:#F7FBF8;--bg3:#F5F7F6;--bg4:#E2EAE5;
  --fg:#1A2B23;--fg2:#5A6B63;--fg3:#8A9B93;
  --accent:#2AB090;--accent2:#1E8A6F;--accent-dim:#E0F5EE;
  --solid:#1A2B23;--solid-hover:#24382F;--solid-contrast:#FFFFFF;
  --danger:#dc2626;--success:#16a34a;--warn:#d97706;
  --radius:12px;--radius-lg:16px;
  --font:'DM Sans','Plus Jakarta Sans',system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  --font-display:'Plus Jakarta Sans','DM Sans',sans-serif;
  --mono:'JetBrains Mono','Fira Code',SFMono-Regular,Menlo,Consolas,monospace;
  --shadow-soft:0 1px 3px rgba(26,43,35,.06),0 8px 20px rgba(26,43,35,.06);
  --shadow-hover:0 2px 8px rgba(26,43,35,.10),0 14px 28px rgba(26,43,35,.10);
}
html[data-theme='dark']{
  --bg:#0E1713;--bg2:#121E19;--bg3:#1A2B23;--bg4:#2E4339;
  --fg:#E5F2EC;--fg2:#B4CBC0;--fg3:#88A498;
  --accent:#34C9A5;--accent2:#2AB090;--accent-dim:#1C3A31;
  --solid:#28453A;--solid-hover:#315447;--solid-contrast:#F7FBF8;
  --danger:#F87171;--success:#4ADE80;--warn:#FBBF24;
  --shadow-soft:0 1px 2px rgba(0,0,0,.35),0 8px 24px rgba(0,0,0,.35);
  --shadow-hover:0 2px 8px rgba(0,0,0,.45),0 16px 32px rgba(0,0,0,.45);
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

/* ── Workspace shell (new UI) ───────────────── */
.workspace-nav{width:248px;background:var(--bg2);border-right:1px solid var(--bg4);padding:20px 14px;display:flex;flex-direction:column;gap:18px}
.brand{display:flex;align-items:center;gap:8px;font-family:var(--font-display);font-weight:700;font-size:20px;color:var(--fg);padding:4px 10px}
.workspace-menu{display:flex;flex-direction:column;gap:6px}
.workspace-menu button,.workspace-menu a{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:12px;color:var(--fg2);font-size:14px;font-weight:600;border:1px solid transparent;transition:all .18s ease}
.workspace-menu button:hover,.workspace-menu a:hover{background:var(--bg3);color:var(--fg)}
.workspace-menu .active{background:var(--accent-dim);color:var(--accent);border-color:rgba(37,99,235,.15)}
.workspace-spacer{flex:1}
.workspace-home{flex:1;display:flex;flex-direction:column;padding:18px 22px;gap:14px;overflow:hidden;min-height:0}
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

/* ── Response toolbar ───────────────────── */
.response-toolbar{display:flex;gap:4px;margin-top:8px;opacity:0;transition:opacity .18s ease}
.msg.assistant:hover .response-toolbar{opacity:1}
.tb-btn{display:inline-flex;align-items:center;gap:5px;padding:5px 12px;border-radius:999px;font-size:11px;font-weight:500;color:var(--fg3);background:var(--bg3);border:1px solid var(--bg4);cursor:pointer;transition:all .18s ease;font-family:var(--font)}
.tb-btn:hover{color:var(--fg);background:var(--bg);border-color:var(--fg3)}
.tb-btn svg{width:13px;height:13px;stroke:currentColor;fill:none;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.tb-btn.copied{color:var(--success);border-color:var(--success);background:rgba(22,163,74,.06)}
.copy-toast{position:fixed;bottom:32px;left:50%;transform:translateX(-50%);background:var(--solid);color:var(--solid-contrast);padding:8px 20px;border-radius:999px;font-size:13px;font-weight:500;z-index:10001;opacity:0;transition:opacity .2s;pointer-events:none}
.copy-toast.show{opacity:1}
.empty-chat{flex:1;display:flex;align-items:center;justify-content:center;color:var(--fg3);font-size:15px;flex-direction:column;gap:8px}
.empty-chat .logo{font-size:48px;margin-bottom:8px}

/* ── Input bar ──────────────────────────────── */
.input-bar{padding:20px 32px;border-top:1px solid var(--bg4);display:flex;gap:12px;align-items:flex-end;background:var(--bg2)}
.input-bar textarea{flex:1;padding:14px 16px;border-radius:var(--radius-lg);border:1px solid var(--bg4);background:var(--bg2);color:var(--fg);font-size:14px;resize:none;min-height:48px;max-height:160px;line-height:1.5;font-family:var(--font);transition:border-color .18s ease}
.input-bar textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(37,99,235,.1)}
.input-bar .send-btn{padding:12px 24px;border-radius:999px;background:var(--solid);color:var(--solid-contrast);font-weight:600;font-size:14px;height:48px;transition:background .18s ease}
.input-bar .send-btn:hover{background:var(--solid-hover)}
.input-bar .send-btn:disabled{opacity:.4;cursor:not-allowed}
.input-bar .model-sel{padding:10px 12px;border-radius:var(--radius);border:1px solid var(--bg4);background:var(--bg2);color:var(--fg2);font-size:13px;height:48px}
.input-tools{display:flex;align-items:center;gap:8px}
.tool-btn{width:42px;height:42px;border-radius:12px;border:1px solid var(--bg4);background:var(--bg3);color:var(--fg2);font-size:16px;display:flex;align-items:center;justify-content:center;transition:all .18s ease}
.tool-btn:hover{background:var(--bg2);border-color:var(--fg3);color:var(--fg)}
.tool-btn.active{background:var(--accent-dim);border-color:var(--accent);color:var(--accent)}
.composer-wrap{flex:1;display:flex;flex-direction:column;gap:8px}
.attach-strip{display:flex;flex-wrap:wrap;gap:8px}
.attach-chip{display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--bg3);border:1px solid var(--bg4);border-radius:999px;font-size:12px;color:var(--fg2);max-width:340px}
.attach-chip .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.attach-chip .remove{width:18px;height:18px;border-radius:999px;background:var(--bg2);border:1px solid var(--bg4);display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--fg3)}
.attach-chip .remove:hover{color:var(--danger);border-color:var(--danger)}
.msg-attachments{display:flex;flex-direction:column;gap:8px;margin-top:8px}
.msg-attachment{border:1px solid var(--bg4);background:var(--bg3);border-radius:10px;padding:8px 10px;font-size:12px;color:var(--fg2)}
.msg-attachment .title{font-weight:700;color:var(--fg);margin-bottom:2px}
.msg-attachment audio{width:100%;margin-top:6px}
.msg-attachment pre{max-height:180px;overflow:auto;margin-top:6px;background:var(--bg2);border:1px solid var(--bg4);border-radius:8px;padding:8px}

/* ── Agent steps & tool calls ───────────── */
.step-card{background:var(--bg3);border:1px solid var(--bg4);border-radius:var(--radius);padding:12px 16px;margin:8px 0;font-size:13px}
.step-card .step-hdr{display:flex;align-items:center;gap:6px;color:var(--accent);font-weight:600;margin-bottom:4px;font-size:12px;text-transform:uppercase;letter-spacing:.3px}
.step-card .step-body{color:var(--fg2);white-space:pre-wrap;word-break:break-word;font-family:var(--mono);font-size:12px;max-height:200px;overflow-y:auto}
.step-card.tool{border-color:rgba(217,119,6,.2)}
.step-card.tool .step-hdr{color:var(--warn)}
.step-card.delegation{border-color:rgba(124,58,237,.2)}
.step-card.delegation .step-hdr{color:#7c3aed}
.step-card.delegation .step-hdr img.delegation-avatar{width:20px;height:20px;border-radius:50%;object-fit:cover;margin-right:4px;vertical-align:middle}
.step-card.thinking{border-color:var(--bg4)}
.step-card.thinking .step-hdr{color:var(--fg3)}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.process-card{background:var(--bg3);border:1px solid var(--bg4);border-radius:var(--radius);margin:8px 0;overflow:hidden}
.process-card.running{border-color:rgba(42,176,144,.22)}
.process-card.completed{border-color:var(--bg4)}
.process-card.error{border-color:rgba(220,38,38,.32)}
.process-card .process-hdr{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 14px;background:rgba(0,0,0,.02)}
.process-card .process-hdr-main{min-width:0;flex:1}
.process-card .process-title{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:700;color:var(--fg);text-transform:uppercase;letter-spacing:.3px}
.process-card .process-stage{display:inline-flex;align-items:center;gap:6px;font-size:10px;padding:2px 8px;border-radius:999px;background:var(--accent-dim);color:var(--accent2);border:1px solid rgba(42,176,144,.2)}
.process-card .process-stage.ok{background:rgba(22,163,74,.08);border-color:rgba(22,163,74,.18);color:var(--success)}
.process-card .process-stage.warn{background:rgba(217,119,6,.08);border-color:rgba(217,119,6,.18);color:var(--warn)}
.process-card .process-stage.deny{background:rgba(220,38,38,.08);border-color:rgba(220,38,38,.18);color:var(--danger)}
.process-card .process-stage-icon{font-size:11px;line-height:1}
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
.process-card .process-body{padding:10px 14px 12px;display:flex;flex-direction:column;gap:10px;transform-origin:top center;transition:transform .18s ease,opacity .18s ease}
.process-card .process-body-wrap.collapsed .process-body{opacity:0;transform:translateY(-6px)}
.process-card .process-section{border:1px solid var(--bg4);background:var(--bg2);border-radius:10px;padding:10px}
.process-card .process-section-title{font-size:10px;color:var(--fg3);text-transform:uppercase;letter-spacing:.3px;margin-bottom:8px}
.process-card .live-thought{border:1px solid var(--bg4);background:var(--bg2);border-radius:10px;padding:8px 10px}
.process-card .live-thought .lbl{font-size:10px;color:var(--fg3);text-transform:uppercase;letter-spacing:.3px;margin-bottom:4px}
.process-card .live-thought .txt{font-size:12px;color:var(--fg2);line-height:1.45;white-space:pre-wrap;word-break:break-word;transition:opacity .18s ease,transform .18s ease}
.process-card .timeline{display:flex;flex-direction:column;gap:6px}
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
.process-card .timeline-item.delegation{border-color:rgba(124,58,237,.25)}
.process-card .timeline-item.response{border-color:rgba(59,130,246,.2)}
.process-card.running .process-stage{animation:processPulse 1.8s ease-in-out infinite}
.process-card.running .live-thought .txt{animation:thoughtReplace .18s ease both}
.process-card .timeline-item,.process-card .skill-item,.process-card .validation-item,.process-card .process-section{animation:processReveal .16s ease both}
.step-card.skill{border-color:rgba(42,176,144,.32);background:linear-gradient(180deg,rgba(42,176,144,.08),rgba(42,176,144,.03))}
.step-card.skill .step-hdr{color:var(--accent2)}
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
@keyframes processReveal{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes thoughtReplace{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
@keyframes processPulse{0%,100%{box-shadow:0 0 0 0 rgba(42,176,144,0)}50%{box-shadow:0 0 0 4px rgba(42,176,144,.08)}}
@media (prefers-reduced-motion: reduce){
  .process-card .process-body-wrap,.process-card .process-body,.process-card .live-thought .txt,.process-card .timeline-item,.process-card .skill-item,.process-card .validation-item,.process-card .process-section,.process-card.running .process-stage{transition:none!important;animation:none!important}
}
.redaction-badge{display:inline-flex;align-items:center;gap:4px;background:rgba(220,38,38,.06);color:var(--danger);font-size:11px;padding:3px 10px;border-radius:999px;margin-bottom:4px;border:1px solid rgba(220,38,38,.15)}
.eval-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:3px 10px;border-radius:999px;margin-left:8px}
.eval-badge.pass{background:rgba(22,163,74,.06);color:var(--success);border:1px solid rgba(22,163,74,.15)}
.eval-badge.fail{background:rgba(220,38,38,.06);color:var(--danger);border:1px solid rgba(220,38,38,.15)}
.mode-badge{display:inline-flex;align-items:center;gap:4px;font-size:10px;padding:3px 10px;border-radius:999px;background:var(--accent-dim);color:var(--accent);text-transform:uppercase;letter-spacing:.5px;font-weight:600;border:1px solid rgba(37,99,235,.15)}
.worker-chip{display:inline-flex;align-items:center;gap:6px;font-size:11px;padding:3px 10px;border-radius:999px;background:var(--bg3);color:var(--fg2);border:1px solid var(--bg4);margin-right:6px;margin-bottom:6px}
.worker-chip img{width:16px;height:16px;border-radius:50%;object-fit:cover}

/* ── Chat header bar ─────────────────────── */
.chat-header{display:flex;align-items:center;justify-content:space-between;padding:12px 24px;border-bottom:1px solid var(--bg4);background:var(--bg2);flex-shrink:0;min-height:56px}
.chat-header-left{display:flex;align-items:center;gap:12px}
.chat-header-right{display:flex;align-items:center;gap:10px}
.hdr-icon-btn{width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:16px;color:var(--fg2);background:var(--bg3);border:1px solid var(--bg4);transition:all .18s ease}
.hdr-icon-btn:hover{background:var(--bg);border-color:var(--fg3);color:var(--fg)}
.hdr-icon-btn.active{background:var(--accent-dim);color:var(--accent);border-color:var(--accent)}
.profile-avatar{width:38px;height:38px;border-radius:50%;background:var(--solid);color:var(--solid-contrast);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;cursor:pointer;border:2px solid transparent;transition:all .18s ease;overflow:hidden}
.profile-avatar img{width:100%;height:100%;object-fit:cover;border-radius:50%}
.profile-avatar:hover{border-color:var(--fg3)}
.model-sel{padding:8px 12px;border-radius:var(--radius);border:1px solid var(--bg4);background:var(--bg2);color:var(--fg2);font-size:13px;font-weight:500}

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

/* ── Settings dropdown ──────────────────── */
.settings-dd{width:360px;padding:24px}
.settings-dd h3{font-size:15px;font-weight:600;margin-bottom:16px;display:flex;align-items:center;gap:8px;color:var(--fg)}
.settings-dd h3 .ai-icon{color:var(--fg3)}

/* ── Settings panel (shared styles) ─────── */
.settings-panel{background:var(--bg2);border:1px solid var(--bg4);border-radius:var(--radius-lg);padding:24px;margin-bottom:16px;box-shadow:var(--shadow-soft)}
.settings-panel h3{font-size:14px;color:var(--fg2);margin-bottom:12px;font-weight:600}
.settings-row{display:flex;align-items:center;gap:12px;margin-bottom:10px;font-size:13px}
.settings-row label{min-width:100px;color:var(--fg3);font-weight:500}
.settings-row select,.settings-row input[type="text"]{padding:8px 12px;border-radius:var(--radius);border:1px solid var(--bg4);background:var(--bg2);color:var(--fg);font-size:13px;transition:border-color .18s}
.settings-row select{min-width:140px}
.settings-row select:focus,.settings-row input:focus{border-color:var(--accent)}
.mode-cards{display:flex;flex-direction:column;gap:8px}
.mode-card{display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:var(--radius);border:1px solid var(--bg4);background:var(--bg2);cursor:pointer;transition:all .18s ease}
.mode-card:hover{border-color:var(--fg3);background:var(--bg3)}
.mode-card.selected{border-color:var(--accent);background:var(--accent-dim)}
.mode-card .mc-icon{font-size:18px;width:28px;text-align:center}
.mode-card .mc-body{flex:1}
.mode-card .mc-title{font-size:13px;font-weight:600;color:var(--fg)}
.mode-card .mc-desc{font-size:11px;color:var(--fg3);margin-top:2px}
.mode-card.selected .mc-title{color:var(--accent)}
.tool-toggle{display:flex;flex-wrap:wrap;gap:6px}
.tool-chip{padding:5px 12px;border-radius:999px;font-size:11px;cursor:pointer;border:1px solid var(--bg4);background:var(--bg2);color:var(--fg2);transition:all .18s ease;font-weight:500}
.tool-chip.active{background:var(--accent-dim);border-color:var(--accent);color:var(--accent)}
.tool-chip:hover{border-color:var(--fg3)}
.toggle-switch{position:relative;width:36px;height:20px;background:var(--bg4);border-radius:10px;cursor:pointer;transition:background .2s}
.toggle-switch.on{background:var(--accent)}
.toggle-switch::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;background:#fff;border-radius:50%;transition:transform .2s;box-shadow:0 1px 3px rgba(17,17,17,.1)}
.toggle-switch.on::after{transform:translateX(16px)}
.settings-section{margin-bottom:16px}
.settings-section:last-child{margin-bottom:0}
.settings-section .sec-label{font-size:11px;color:var(--fg3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;font-weight:600}
.settings-section .sec-row{display:flex;align-items:center;gap:8px;font-size:13px}

/* ── Trace viewer ───────────────────────── */
.trace-tree{font-size:12px;font-family:var(--mono)}
.trace-span{padding:6px 10px;margin:2px 0;border-radius:var(--radius);background:var(--bg2);border:1px solid var(--bg4);display:flex;justify-content:space-between;align-items:center}
.trace-span .span-name{color:var(--accent);font-weight:500}
.trace-span .span-dur{color:var(--fg3);font-size:11px}
.trace-span.child{margin-left:20px;border-left:2px solid var(--bg4)}
.trace-span .span-status{width:8px;height:8px;border-radius:50%;margin-right:6px;flex-shrink:0}
.trace-span .span-status.ok{background:var(--success)}
.trace-span .span-status.error{background:var(--danger)}
.streaming-indicator span{animation:blink 1.4s infinite both}
.streaming-indicator span:nth-child(2){animation-delay:.2s}
.streaming-indicator span:nth-child(3){animation-delay:.4s}
@keyframes blink{0%,80%,100%{opacity:.2}40%{opacity:1}}

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
.eval-table th,.eval-table td{padding:10px 14px;text-align:left;border-bottom:1px solid var(--bg4)}
.eval-table th{color:var(--fg3);font-weight:500;text-transform:uppercase;font-size:11px;letter-spacing:.5px}
.eval-table td{color:var(--fg2)}
.table-wrap{background:var(--bg2);border:1px solid var(--bg4);border-radius:var(--radius-lg);overflow:hidden;box-shadow:var(--shadow-soft)}
.table-wrap h3{font-size:14px;color:var(--fg2);padding:20px 20px 0;font-weight:600}

/* ── Accordion / Agent Activity ─────────────── */
.agent-activity{margin-top:32px}
.agent-activity>h3{font-size:18px;font-weight:700;margin-bottom:16px;display:flex;align-items:center;gap:8px;color:var(--fg)}
.acc-item{background:var(--bg2);border:1px solid var(--bg4);border-radius:var(--radius-lg);margin-bottom:8px;overflow:hidden;transition:all .18s ease;box-shadow:var(--shadow-soft)}
.acc-item.open{border-color:var(--fg3)}
.acc-hdr{display:flex;align-items:center;gap:10px;padding:14px 20px;cursor:pointer;user-select:none;transition:background .18s ease}
.acc-hdr:hover{background:var(--bg3)}
.acc-chevron{font-size:10px;color:var(--fg3);transition:transform .2s;flex-shrink:0;width:16px}
.acc-item.open .acc-chevron{transform:rotate(90deg)}
.acc-icon{font-size:16px;width:28px;text-align:center;flex-shrink:0}
.acc-title{flex:1;min-width:0}
.acc-title .acc-name{font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--fg)}
.acc-title .acc-sub{font-size:12px;color:var(--fg3);margin-top:2px;display:flex;gap:10px;flex-wrap:wrap}
.acc-badges{display:flex;gap:6px;flex-shrink:0}
.acc-badge{font-size:10px;padding:3px 10px;border-radius:999px;font-weight:600;text-transform:uppercase;letter-spacing:.3px}
.acc-badge.mode-direct{background:var(--bg3);color:var(--fg3);border:1px solid var(--bg4)}
.acc-badge.mode-agent{background:var(--accent-dim);color:var(--accent);border:1px solid rgba(37,99,235,.15)}
.acc-badge.mode-supervisor{background:rgba(124,58,237,.06);color:#7c3aed;border:1px solid rgba(124,58,237,.15)}
.acc-body{display:none;padding:0 20px 20px;border-top:1px solid var(--bg4)}
.acc-item.open .acc-body{display:block}
.acc-section{margin-top:12px}
.acc-section .asl{font-size:10px;color:var(--fg3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;font-weight:600}
.acc-kv{display:grid;grid-template-columns:120px 1fr;gap:4px 12px;font-size:12px;margin-bottom:6px}
.acc-kv .ak{color:var(--fg3);font-weight:500}
.acc-kv .av{color:var(--fg);word-break:break-all}
.acc-kv .av.mono{font-family:var(--mono);font-size:11px;color:var(--accent2)}
.acc-prompt{font-family:var(--mono);font-size:11px;background:var(--bg3);border:1px solid var(--bg4);border-radius:var(--radius);padding:12px;white-space:pre-wrap;word-break:break-word;max-height:120px;overflow-y:auto;color:var(--fg2)}
.acc-tools{display:flex;flex-wrap:wrap;gap:4px;margin-top:2px}
.acc-tool-tag{font-size:10px;padding:3px 10px;border-radius:999px;background:var(--accent-dim);color:var(--accent);font-family:var(--mono);border:1px solid rgba(37,99,235,.12)}
.step-acc{margin-top:8px}
.step-acc-item{background:var(--bg3);border:1px solid var(--bg4);border-radius:var(--radius);margin-bottom:4px;overflow:hidden}
.step-acc-hdr{display:flex;align-items:center;gap:8px;padding:10px 14px;cursor:pointer;font-size:12px;transition:background .15s}
.step-acc-hdr:hover{background:var(--bg)}
.step-acc-chevron{font-size:9px;color:var(--fg3);transition:transform .2s;width:12px;flex-shrink:0}
.step-acc-item.open .step-acc-chevron{transform:rotate(90deg)}
.step-acc-icon{font-size:14px;width:20px;text-align:center}
.step-acc-title{flex:1;font-weight:500;color:var(--fg)}
.step-acc-dur{font-size:11px;color:var(--fg3);font-family:var(--mono)}
.step-acc-body{display:none;padding:10px 14px;border-top:1px solid var(--bg4);font-size:11px;font-family:var(--mono)}
.step-acc-item.open .step-acc-body{display:block}
.step-acc-body pre{background:var(--bg2);border:1px solid var(--bg4);border-radius:var(--radius);padding:10px;white-space:pre-wrap;word-break:break-word;overflow-x:auto;max-height:200px;overflow-y:auto;margin:4px 0}
.step-acc-body .step-label{font-size:10px;color:var(--fg3);text-transform:uppercase;letter-spacing:.3px;margin-bottom:3px}

/* ── Scrollbar ────────────────────────────── */
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--bg4);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:var(--fg3)}

@media(max-width:1100px){.workspace-body{grid-template-columns:1fr}.right-rail{display:none}}
@media(max-width:900px){.charts{grid-template-columns:1fr}.workspace-nav{width:78px}.workspace-menu button span,.workspace-menu a span,.brand .word{display:none}.workspace-top-card{grid-template-columns:1fr;gap:10px}}
@media(max-width:640px){.workspace-nav{display:none}.app{flex-direction:column}.workspace-home{padding:10px}}
</style>
</head>
<body>
<div id="app"></div>
<script>
"use strict";
var ADMIN_GROUPS = ${JSON.stringify(ADMIN_TAB_GROUPS)};
var ADMIN_SCHEMA = ${JSON.stringify(ADMIN_TABS)};
const $ = (s,p) => (p||document).querySelector(s);
const $$ = (s,p) => [...(p||document).querySelectorAll(s)];
const h = (tag,attrs,...ch) => {
  const el = document.createElement(tag);
  if(attrs) Object.entries(attrs).forEach(([k,v])=>{
    if(k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(),v);
    else if(k==='className') el.className=v;
    else if(k==='htmlFor') el.setAttribute('for',v);
    else if(v==null||v===false) el.removeAttribute(k);
    else el.setAttribute(k,v);
  });
  ch.flat(Infinity).forEach(c=>{
    if(c==null) return;
    el.appendChild(typeof c==='string'?document.createTextNode(c):c);
  });
  return el;
};

/* ── Markdown to HTML (lightweight) ─────────── */
function mdToHtml(md){
  if(!md) return '';
  let html = md;
  var BT = String.fromCharCode(96);
  // Code blocks (fenced)
  html = html.replace(new RegExp(BT+BT+BT+'(\\\\w*)\\\\n([\\\\s\\\\S]*?)'+BT+BT+BT,'g'), function(m,lang,code){
    var escaped = code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return '<pre><code'+(lang?' class="lang-'+lang+'"':'')+'>'+ escaped.trimEnd() +'</code></pre>';
  });
  // Inline code
  html = html.replace(new RegExp(BT+'([^'+BT+']+)'+BT,'g'), '<code>$1</code>');
  // Headings
  html = html.replace(/^#### (.+)$/gm,'<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm,'<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm,'<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm,'<h1>$1</h1>');
  // Bold + italic
  html = html.replace(/\\*\\*\\*(.+?)\\*\\*\\*/g,'<strong><em>$1</em></strong>');
  html = html.replace(/\\*\\*(.+?)\\*\\*/g,'<strong>$1</strong>');
  html = html.replace(/(?!\\*\\*)\\*([^*]+?)\\*(?!\\*)/g,'<em>$1</em>');
  // Horizontal rule
  html = html.replace(/^---$/gm,'<hr/>');
  // Blockquote
  html = html.replace(/^> (.+)$/gm,'<blockquote>$1</blockquote>');
  // Links
  html = html.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
  // Unordered list items
  html = html.replace(/^(\\s*)[-*] (.+)$/gm,'$1<li>$2</li>');
  // Ordered list items
  html = html.replace(/^(\\s*)\\d+\\. (.+)$/gm,'$1<li>$2</li>');
  // Wrap consecutive <li> in <ul>
  html = html.replace(/((?:<li>.*<\\/li>\\n?)+)/g,'<ul>$1</ul>');
  // Tables
  html = html.replace(/^\\|(.+)\\|\\s*\\n\\|[-| :]+\\|\\s*\\n((?:\\|.+\\|\\s*\\n?)*)/gm, function(m,hdr,rows){
    var ths = hdr.split('|').map(function(c){return '<th>'+c.trim()+'</th>';}).join('');
    var trs = rows.trim().split('\\n').map(function(r){
      var tds = r.replace(/^\\||\\|$/g,'').split('|').map(function(c){return '<td>'+c.trim()+'</td>';}).join('');
      return '<tr>'+tds+'</tr>';
    }).join('');
    return '<table><thead><tr>'+ths+'</tr></thead><tbody>'+trs+'</tbody></table>';
  });
  // Paragraphs: wrap remaining loose lines
  html = html.replace(/^(?!<[hupbolta]|<li|<hr|<blockquote|<pre|<table|<thead|<tbody|<tr|<td|<th|<ul|<ol)(.+)$/gm,'<p>$1</p>');
  // Clean up double newlines
  html = html.replace(/\\n{2,}/g,'\\n');
  return html.trim();
}

/* ── Toolbar actions ────────────────────────── */
function copyResponse(text, btn){
  // Copy as plain text
  navigator.clipboard.writeText(text).then(()=>{
    btn.classList.add('copied');
    btn.querySelector('.tb-label').textContent = 'Copied!';
    setTimeout(()=>{ btn.classList.remove('copied'); btn.querySelector('.tb-label').textContent = 'Copy'; },1500);
  });
}

function copyTextWithFeedback(text, btn, idleLabel, copiedLabel){
  if(!btn) return;
  const idle = idleLabel || 'Copy';
  const done = copiedLabel || 'Copied';
  const finish = function(){
    btn.classList.add('copied');
    btn.textContent = done;
    setTimeout(function(){
      btn.classList.remove('copied');
      btn.textContent = idle;
    }, 1200);
  };
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(String(text || '')).then(finish).catch(function(){
      window.prompt('Copy text:', String(text || ''));
    });
  }else{
    window.prompt('Copy text:', String(text || ''));
  }
}

function emailResponse(text, subject){
  const body = encodeURIComponent(text);
  const subj = encodeURIComponent(subject || 'geneWeave Response');
  window.open('mailto:?subject='+subj+'&body='+body, '_blank');
}

function openInWord(htmlContent, plainText){
  // Create a .doc compatible HTML file (Word can open HTML)
  const wordHtml = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">'
    + '<head><meta charset="utf-8"/><style>body{font-family:Calibri,Arial,sans-serif;font-size:11pt;line-height:1.6;color:#111}'
    + 'h1{font-size:18pt}h2{font-size:15pt}h3{font-size:13pt}h4{font-size:11pt}'
    + 'code{font-family:Consolas,monospace;font-size:10pt;background:#f4f4f4;padding:1px 4px}'
    + 'pre{background:#f4f4f4;padding:10px;font-family:Consolas,monospace;font-size:10pt}'
    + 'blockquote{border-left:3px solid #ccc;padding-left:12px;color:#555}'
    + 'table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:6px 10px}th{background:#f0f0f0}'
    + '</style></head><body>' + htmlContent + '</body></html>';
  const blob = new Blob([wordHtml], {type:'application/msword'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'geneweave-response.doc';
  a.click();
  URL.revokeObjectURL(url);
}

/* ── State ──────────────────────────────────── */
let state = {
  user:null, csrfToken:null,
  chats:[], currentChatId:null, messages:[],
  view:'chat', // 'chat' | 'dashboard' | 'admin' | 'connectors' | 'preferences'
  streaming:false, models:[], selectedModel:'',
  dashboard:null, authMode:'login', authError:'',
  // New: settings, tools, traces
  chatSettings:null, availableTools:[], showSettings:false, defaultMode:'direct',
  theme:'light',
  showProfile:false,
  showNotifications:false,
  chatSearchQuery:'',
  chatSearchResults:[],
  chatSearchLoading:false,
  chatSearchIndex:[],
  chatSearchReady:false,
  _chatSearchTimer:null,
  calendarFocusDate:null,
  calendarShowAll:false,
  calendarTab:'meetings',
  traces:[],
  pendingAttachments:[],
  pendingDraft:'',
  audioRecording:false,
  audioRecorder:null,
  audioStream:null,
  audioRecognition:null,
  audioTranscript:'',
  // Admin state
  adminTab:'prompts',
  adminData:{},
  adminEditing:null, adminForm:{},
  // About state
  _aboutInfo:null, _upgradeStatus:null, _upgradeMsg:null,
  // Connectors state
  connectors:{ enterprise:[], social:[] },
  connectorsLoading:false,
  // Website Credentials state
  credentials:[],
  credentialForm:null,
  credentialEditing:null,
  ssoProviders:null,  // Linked SSO providers
  // Import state
  importProviders:null,
  importShow:false,
  importProvider:null,
  importConfig:{},
  importLoading:false,
  importResult:null,
  // Handoff state
  handoffRequest:null,
};

function normalizeTheme(theme){
  return theme === 'dark' ? 'dark' : 'light';
}

function applyTheme(theme){
  const normalized = normalizeTheme(theme);
  state.theme = normalized;
  document.documentElement.setAttribute('data-theme', normalized);
}

function loadStoredTheme(){
  try {
    return normalizeTheme(window.localStorage.getItem('geneweave.theme') || 'light');
  } catch {
    return 'light';
  }
}

function persistTheme(theme){
  try { window.localStorage.setItem('geneweave.theme', normalizeTheme(theme)); } catch {}
}

applyTheme(loadStoredTheme());

/* ── Avatar helpers ─────────────────────────── */
const AVATAR_COUNT = 26;
// Deterministic avatar index from a string (user id, email, or agent name)
function avatarIndex(seed){
  if(!seed) return 1;
  var hash = 0;
  for(var i=0;i<seed.length;i++){ hash = ((hash<<5)-hash)+seed.charCodeAt(i); hash |= 0; }
  return (Math.abs(hash) % AVATAR_COUNT) + 1;
}
function avatarUrl(index){ return '/avatar/avatar-'+index+'.webp'; }
function getUserAvatarUrl(){ return avatarUrl(avatarIndex(state.user?.id||state.user?.email||'user')); }
function getAgentAvatarUrl(agentName){ return avatarUrl(avatarIndex(agentName||'geneweave-agent')); }

function getTodayLabel(){
  return new Date().toLocaleDateString(undefined,{weekday:'short', day:'2-digit', month:'short'});
}

function toYMD(d){
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return y+'-'+m+'-'+day;
}

function fromYMD(ymd){
  const p = String(ymd||'').split('-').map(Number);
  if(p.length!==3 || !p[0] || !p[1] || !p[2]) return new Date();
  return new Date(p[0], p[1]-1, p[2]);
}

function getCalendarFocusDate(){
  if(!state.calendarFocusDate) state.calendarFocusDate = toYMD(new Date());
  return fromYMD(state.calendarFocusDate);
}

function setCalendarFocusDate(d){
  state.calendarFocusDate = toYMD(d);
}

function shiftCalendarMonth(delta){
  const d = getCalendarFocusDate();
  const shifted = new Date(d.getFullYear(), d.getMonth()+delta, d.getDate());
  setCalendarFocusDate(shifted);
  render();
}

function normalizeText(s){
  return String(s||'').toLowerCase().replace(/[^a-z0-9\\s]/g,' ').replace(/\\s+/g,' ').trim();
}

function tokenSet(s){
  const txt = normalizeText(s);
  if(!txt) return new Set();
  return new Set(txt.split(' ').filter(Boolean));
}

function trigramSet(s){
  const txt = normalizeText(s).replace(/\\s+/g,' ');
  const out = new Set();
  if(txt.length<3){ if(txt) out.add(txt); return out; }
  for(let i=0;i<=txt.length-3;i++) out.add(txt.slice(i,i+3));
  return out;
}

function semanticScore(query,text){
  const q = normalizeText(query);
  const t = normalizeText(text);
  if(!q||!t) return 0;
  let score = 0;
  if(t.includes(q)) score += 0.55;

  const qTokens = tokenSet(q);
  const tTokens = tokenSet(t);
  let overlap = 0;
  qTokens.forEach(tok=>{ if(tTokens.has(tok)) overlap++; });
  score += (qTokens.size ? (overlap / qTokens.size) : 0) * 0.3;

  const qTri = trigramSet(q);
  const tTri = trigramSet(t);
  let triOverlap = 0;
  qTri.forEach(g=>{ if(tTri.has(g)) triOverlap++; });
  const triUnion = qTri.size + tTri.size - triOverlap;
  score += (triUnion ? triOverlap / triUnion : 0) * 0.15;

  return score;
}

async function ensureChatSearchIndex(){
  if(state.chatSearchReady) return;
  const topChats = state.chats.slice(0,30);
  const rows = await Promise.all(topChats.map(async (c)=>{
    try{
      const r = await api.get('/chats/'+c.id+'/messages');
      const payload = r.ok ? await r.json() : {messages:[]};
      const msgs = payload.messages || [];
      const merged = msgs.slice(-6).map(m=>m.content||'').join(' ');
      return {id:c.id,title:c.title||'New Chat',updated_at:c.updated_at||c.created_at||'',text:(c.title||'')+' '+merged};
    }catch{
      return {id:c.id,title:c.title||'New Chat',updated_at:c.updated_at||c.created_at||'',text:c.title||''};
    }
  }));
  state.chatSearchIndex = rows;
  state.chatSearchReady = true;
}

async function runSemanticChatSearch(query){
  const q = String(query||'').trim();
  state.chatSearchQuery = query;
  if(!q){
    state.chatSearchResults = [];
    state.chatSearchLoading = false;
    render();
    return;
  }
  state.chatSearchLoading = true;
  render();
  await ensureChatSearchIndex();
  const ranked = state.chatSearchIndex
    .map(item=>({item, score: semanticScore(q, item.text)}))
    .filter(x=>x.score>0.12)
    .sort((a,b)=>b.score-a.score)
    .slice(0,8)
    .map(x=>x.item);
  state.chatSearchResults = ranked;
  state.chatSearchLoading = false;
  render();
}

function getDelegatedWorkers(messages){
  const names = [];
  (messages||[]).forEach(m=>{
    (m.steps||[]).forEach(s=>{
      if(s.type==='delegation'){
        const n = s.worker||s.name;
        if(n && !names.includes(n)) names.push(n);
      }
      if(s.type==='tool_call' && s.toolCall?.name==='delegate_to_worker'){
        const n = s.toolCall?.arguments?.worker;
        if(n && !names.includes(n)) names.push(n);
      }
    });
  });
  return names;
}

function normalizeLoadedMessage(row){
  var msg = Object.assign({}, row);
  var md = null;
  if(typeof msg.metadata === 'string' && msg.metadata){
    try { md = JSON.parse(msg.metadata); } catch { md = null; }
  }
  if(md && Array.isArray(md.attachments)) msg.attachments = md.attachments;
  if(msg.role !== 'assistant' || !md) return msg;
  msg.steps = Array.isArray(md.steps) ? md.steps : [];
  msg.mode = md.mode || 'direct';
  msg.evalResult = md.eval || null;
  msg.cognitive = md.cognitive || null;
  msg.redaction = md.redaction || null;
  msg.guardrail = md.guardrail || null;
  msg.activeSkills = Array.isArray(md.activeSkills) ? md.activeSkills : [];
  msg.enabledTools = Array.isArray(md.enabledTools) ? md.enabledTools : [];
  msg.skillTools = Array.isArray(md.skillTools) ? md.skillTools : [];
  msg.skillPromptApplied = !!md.skillPromptApplied;
  msg.processState = 'completed';
  msg.processExpanded = false;
  msg.processUi = { detailExpanded: Object.create(null) };
  msg.usage = {
    totalTokens: msg.tokens_used || 0,
  };
  msg.cost = msg.cost || 0;
  msg.latency_ms = msg.latency_ms || 0;
  return msg;
}

function toBase64(blob){
  return new Promise(function(resolve,reject){
    var reader = new FileReader();
    reader.onload = function(){
      var s = String(reader.result || '');
      var idx = s.indexOf(',');
      resolve(idx >= 0 ? s.slice(idx+1) : s);
    };
    reader.onerror = function(){ reject(reader.error || new Error('Failed to read file')); };
    reader.readAsDataURL(blob);
  });
}

async function queueFiles(files){
  if(!files || !files.length) return;
  var accepted = [];
  for(var i=0;i<files.length && accepted.length<8;i++){
    var f = files[i];
    if(!f) continue;
    if(f.size <= 0 || f.size > 4 * 1024 * 1024) continue;
    var b64 = await toBase64(f);
    accepted.push({
      name: f.name || ('file-'+Date.now()),
      mimeType: f.type || 'application/octet-stream',
      size: f.size,
      dataBase64: b64,
    });
  }
  state.pendingAttachments = state.pendingAttachments.concat(accepted).slice(0,8);
  render();
}

function removePendingAttachment(index){
  state.pendingAttachments = state.pendingAttachments.filter(function(_,i){ return i !== index; });
  render();
}

function stopAudioRecognition(){
  if(state.audioRecognition){
    try { state.audioRecognition.onresult = null; state.audioRecognition.onerror = null; state.audioRecognition.onend = null; state.audioRecognition.stop(); } catch {}
    state.audioRecognition = null;
  }
}

async function toggleAudioRecording(){
  if(state.audioRecording){
    if(state.audioRecorder){
      try { state.audioRecorder.stop(); } catch {}
    }
    return;
  }

  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    alert('Audio capture is not supported in this browser.');
    return;
  }

  var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  var chunks = [];
  var mimeType = typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/webm')
    ? 'audio/webm'
    : '';
  var recorder = mimeType ? new MediaRecorder(stream, { mimeType: mimeType }) : new MediaRecorder(stream);

  state.audioRecording = true;
  state.audioRecorder = recorder;
  state.audioStream = stream;
  state.audioTranscript = '';

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if(SR){
    try {
      var recognition = new SR();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'en-US';
      recognition.onresult = function(event){
        var transcript = '';
        for(var i=0;i<event.results.length;i++){
          transcript += event.results[i][0].transcript || '';
        }
        state.audioTranscript = transcript.trim();
      };
      recognition.onerror = function(){ /* ignore */ };
      recognition.start();
      state.audioRecognition = recognition;
    } catch { /* ignore */ }
  }

  recorder.ondataavailable = function(event){
    if(event.data && event.data.size > 0) chunks.push(event.data);
  };
  recorder.onstop = async function(){
    stopAudioRecognition();
    var capturedTranscript = (state.audioTranscript || '').trim();
    if(capturedTranscript){
      // Transcript captured — send as plain text, never upload the raw audio file
      state.pendingDraft = capturedTranscript;
    }
    // If no transcript, nothing is sent (raw audio is not processable by the LLM)
    if(state.audioStream){
      state.audioStream.getTracks().forEach(function(t){ t.stop(); });
    }
    state.audioRecording = false;
    state.audioRecorder = null;
    state.audioStream = null;
    state.audioTranscript = '';
    render();
  };

  recorder.start();
  render();
}

/* ── API ────────────────────────────────────── */
const api = {
  async post(path,body){
    const headers = {'Content-Type':'application/json'};
    if(state.csrfToken) headers['X-CSRF-Token'] = state.csrfToken;
    const r = await fetch('/api'+path,{method:'POST',headers,body:JSON.stringify(body),credentials:'same-origin'});
    return r;
  },
  async get(path){
    return fetch('/api'+path,{credentials:'same-origin'});
  },
  async del(path){
    const headers = {};
    if(state.csrfToken) headers['X-CSRF-Token'] = state.csrfToken;
    return fetch('/api'+path,{method:'DELETE',headers,credentials:'same-origin'});
  },
  async put(path,body){
    const headers = {'Content-Type':'application/json'};
    if(state.csrfToken) headers['X-CSRF-Token'] = state.csrfToken;
    return fetch('/api'+path,{method:'PUT',headers,body:JSON.stringify(body),credentials:'same-origin'});
  }
};

/* ── Auth ───────────────────────────────────── */
async function doLogin(email,password){
  const r = await api.post('/auth/login',{email,password});
  const d = await r.json();
  if(!r.ok){ state.authError = d.error||'Login failed'; render(); return; }
  state.user = d.user; state.csrfToken = d.csrfToken; state.authError='';
  await loadChats(); await Promise.all([loadModels(), loadTools(), loadUserPreferences()]); render();
}
async function doRegister(name,email,password){
  const r = await api.post('/auth/register',{name,email,password});
  const d = await r.json();
  if(!r.ok){ state.authError = d.error||'Register failed'; render(); return; }
  state.user = d.user; state.csrfToken = d.csrfToken; state.authError='';
  await loadChats(); await Promise.all([loadModels(), loadTools(), loadUserPreferences()]); render();
}
async function doLogout(){
  await api.post('/auth/logout',{});
  state.user=null; state.csrfToken=null; state.chats=[]; state.currentChatId=null; state.messages=[]; state.dashboard=null;
  render();
}

async function initiateOAuthFlow(provider){
  try {
    // Get the authorization URL from the backend
    const r = await api.post('/oauth/authorize-url', { provider });
    const d = await r.json();
    if (!r.ok) {
      state.authError = d.error || provider + ' sign-in failed';
      render();
      return;
    }

    // Open the OAuth authorization URL in a popup
    const width = 500, height = 600;
    const left = window.screenX + (window.outerWidth - width) / 2;
    const top = window.screenY + (window.outerHeight - height) / 2;
    const popup = window.open(d.authUrl, provider + '-auth', 'width=' + width + ',height=' + height + ',left=' + left + ',top=' + top);
    
    if (!popup) {
      state.authError = 'Popup blocked. Please allow popups for this site.';
      render();
      return;
    }

    let completed = false;
    let pollTimer = null;
    let timeoutTimer = null;

    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      if (pollTimer) clearInterval(pollTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
    };

    const finalizeAuth = () => {
      if (completed) return;
      api.get('/auth/me').then(meR => {
        if (!meR.ok) return;
        return meR.json().then(meD => {
          completed = true;
          cleanup();
          state.user = meD.user;
          state.csrfToken = meD.csrfToken;
          state.authError = '';
          try { popup.close(); } catch (_) { /* ignore */ }
          return Promise.all([loadChats(), loadModels(), loadTools(), loadUserPreferences()]).then(() => render());
        });
      }).catch(err => {
        state.authError = 'OAuth error: ' + (err.message || err);
        render();
      });
    };

    const onMessage = (event) => {
      if (event.origin !== window.location.origin) return;
      if (!event.data || event.data.type !== 'oauth-success') return;
      finalizeAuth();
    };

    window.addEventListener('message', onMessage);

    // Primary completion path: callback posts oauth-success to opener.
    // Fallback: periodically check auth state without reading popup.closed (COOP-safe).
    pollTimer = setInterval(finalizeAuth, 1500);
    timeoutTimer = setTimeout(() => {
      if (completed) return;
      cleanup();
      state.authError = 'OAuth timed out. Please try again.';
      render();
    }, 120000);
  } catch (err) {
    state.authError = 'OAuth error: ' + (err.message || err);
    render();
  }
}

/* ── Chats ──────────────────────────────────── */
async function loadChats(){
  const r = await api.get('/chats');
  if(r.ok){
    state.chats = (await r.json()).chats ?? [];
    state.chatSearchReady = false;
  }
}
async function loadModels(){
  const r = await api.get('/models');
  if(r.ok){
    const d = await r.json();
    state.models = d.models ?? [];
    if(!state.selectedModel && d.defaultModel) state.selectedModel = d.defaultModel;
  }
}
async function loadTools(){
  const r = await api.get('/tools');
  if(r.ok) state.availableTools = (await r.json()).tools ?? [];
}
async function loadChatSettings(chatId){
  if(!chatId){state.chatSettings=null;return;}
  try{
    const r = await api.get('/chats/'+chatId+'/settings');
    if(r.ok){
      const d = (await r.json()).settings;
      state.chatSettings = {
        mode: d.mode||'direct',
        systemPrompt: d.system_prompt||'',
        timezone: d.timezone || '',
        enabledTools: d.enabled_tools ? JSON.parse(d.enabled_tools) : [],
        redactionEnabled: !!d.redaction_enabled,
        redactionPatterns: d.redaction_patterns ? JSON.parse(d.redaction_patterns) : ['email','phone','ssn','credit_card'],
        workers: d.workers ? JSON.parse(d.workers) : []
      };
    } else {
      console.warn('loadChatSettings: non-ok response', r.status);
      state.chatSettings = { mode:state.defaultMode||'direct', systemPrompt:'', timezone:'', enabledTools:[], redactionEnabled:false, redactionPatterns:['email','phone','ssn','credit_card'], workers:[] };
    }
  }catch(e){
    console.warn('loadChatSettings error', e);
    state.chatSettings = { mode:state.defaultMode||'direct', systemPrompt:'', timezone:'', enabledTools:[], redactionEnabled:false, redactionPatterns:['email','phone','ssn','credit_card'], workers:[] };
  }
}
async function saveChatSettings(){
  if(!state.currentChatId||!state.chatSettings) return;
  await api.post('/chats/'+state.currentChatId+'/settings', state.chatSettings);
  // Also persist mode as user default
  if(state.chatSettings.mode && state.chatSettings.mode !== state.defaultMode){
    state.defaultMode = state.chatSettings.mode;
    api.post('/user/preferences', {default_mode:state.chatSettings.mode, theme:state.theme});
  }
}

async function saveUserPreferences(){
  await api.post('/user/preferences', {default_mode:state.defaultMode, theme:state.theme});
}

async function setTheme(theme){
  const normalized = normalizeTheme(theme);
  if(state.theme === normalized) return;
  applyTheme(normalized);
  persistTheme(normalized);
  if(state.user){
    try { await saveUserPreferences(); } catch(e){ console.warn('setTheme save failed', e); }
  }
  render();
}

async function loadUserPreferences(){
  try{
    const r = await api.get('/user/preferences');
    if(r.ok){
      const d = await r.json();
      state.defaultMode = d.preferences?.default_mode || 'direct';
      const resolvedTheme = normalizeTheme(d.preferences?.theme || state.theme || 'light');
      applyTheme(resolvedTheme);
      persistTheme(resolvedTheme);
    }
  }catch(e){ console.warn('loadUserPreferences error', e); }
}
async function loadChatTraces(chatId){
  const r = await api.get('/chats/'+chatId+'/traces');
  if(r.ok) state.traces = (await r.json()).traces ?? [];
}
async function createChat(){
  const mParts = state.selectedModel.split(':');
  const r = await api.post('/chats',{model:mParts[1]||state.selectedModel,provider:mParts[0]||''});
  if(r.ok){ const d=await r.json(); state.chats.unshift(d.chat); state.currentChatId=d.chat.id; state.messages=[]; state.chatSearchReady=false; await loadChatSettings(d.chat.id); if(state.chatSettings && state.defaultMode){ state.chatSettings.mode=state.defaultMode; saveChatSettings(); } render(); }
}
async function selectChat(id){
  state.currentChatId=id;
  const r = await api.get('/chats/'+id+'/messages');
  if(r.ok){
    const rows = (await r.json()).messages ?? [];
    state.messages = rows.map(normalizeLoadedMessage);
  }
  state.chatSearchQuery='';
  state.chatSearchResults=[];
  await loadChatSettings(id);
  state.showSettings=false;
  render();
}
async function deleteChat(id){
  await api.del('/chats/'+id);
  state.chats = state.chats.filter(c=>c.id!==id);
  state.chatSearchReady=false;
  if(state.currentChatId===id){ state.currentChatId=null; state.messages=[]; }
  render();
}

/* ── Send message with streaming ────────────── */
async function sendMessage(content){
  var text = String(content||'').trim();
  var attachments = (state.pendingAttachments || []).slice();
  if((!text && !attachments.length) || state.streaming) return;
  if(!state.currentChatId) await createChat();
  const chatId = state.currentChatId;
  state.messages.push({
    role:'user',
    content:text,
    created_at:new Date().toISOString(),
    attachments: attachments,
    metadata: attachments.length ? JSON.stringify({ attachments: attachments }) : null,
  });
  state.pendingAttachments = [];
  state.streaming=true; render();
  scrollMessages();

  const mParts = state.selectedModel.split(':');
  const body = {
    content:text,
    stream:true,
    model:mParts[1]||undefined,
    provider:mParts[0]||undefined,
    attachments: attachments.length ? attachments : undefined,
  };
  const headers = {'Content-Type':'application/json'};
  if(state.csrfToken) headers['X-CSRF-Token'] = state.csrfToken;
  const startedAtMs = Date.now();
  let assistantMsg = null;

  try {
    const resp = await fetch('/api/chats/'+chatId+'/messages',{method:'POST',headers,body:JSON.stringify(body),credentials:'same-origin'});
    if(!resp.ok || !resp.body) throw new Error('Streaming request failed ('+resp.status+')');
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    assistantMsg = {
      role:'assistant',
      content:'',
      usage:null,
      cost:0,
      latency_ms:0,
      created_at:new Date().toISOString(),
      steps:[],
      evalResult:null,
      redaction:null,
      mode:state.chatSettings?.mode||'direct',
      processState:'running',
      processExpanded:true,
      processUi:{detailExpanded:Object.create(null)},
    };
    state.messages.push(assistantMsg);
    render(); scrollMessages();

    let buf = '';
    while(true){
      const {done,value} = await reader.read();
      if(done) break;
      buf += decoder.decode(value,{stream:true});
      const lines = buf.split('\\n');
      buf = lines.pop()||'';
      for(const line of lines){
        if(!line.startsWith('data: ')) continue;
        try {
          const d = JSON.parse(line.slice(6));
          if(d.type==='text') assistantMsg.content += d.text;
          else if(d.type==='reasoning' && d.text) assistantMsg.steps.push({type:'thinking',text:d.text});
          else if(d.type==='step') assistantMsg.steps.push(d.step||d);
          else if(d.type==='tool_start') assistantMsg.steps.push({kind:'tool_start',name:d.name,input:d.input});
          else if(d.type==='tool_end'){ const last=assistantMsg.steps[assistantMsg.steps.length-1]; if(last&&last.kind==='tool_start') last.result=d.result; }
          else if(d.type==='redaction') assistantMsg.redaction=d;
          else if(d.type==='eval') assistantMsg.evalResult=d;
          else if(d.type==='cognitive') assistantMsg.cognitive=d;
          else if(d.type==='guardrail') assistantMsg.guardrail=d;
          else if(d.type==='screenshot'){ if(!assistantMsg.screenshots) assistantMsg.screenshots=[]; assistantMsg.screenshots.push({base64:d.base64,format:d.format||'png'}); }
          else if(d.type==='handoff'){ state.handoffRequest=d; render(); }
          else if(d.type==='done'){
            assistantMsg.usage=d.usage;
            assistantMsg.cost=d.cost;
            assistantMsg.latency_ms=d.latencyMs;
            if(d.steps) assistantMsg.steps=d.steps;
            if(d.eval) assistantMsg.evalResult=d.eval;
            if(d.cognitive) assistantMsg.cognitive=d.cognitive;
            assistantMsg.activeSkills = Array.isArray(d.activeSkills) ? d.activeSkills : [];
            assistantMsg.enabledTools = Array.isArray(d.enabledTools) ? d.enabledTools : [];
            assistantMsg.skillTools = Array.isArray(d.skillTools) ? d.skillTools : [];
            assistantMsg.skillPromptApplied = !!d.skillPromptApplied;
            assistantMsg.processState = 'completed';
            assistantMsg.processExpanded = false;
          }
          else if(d.type==='error'){
            assistantMsg.content += '\\n[Error: '+d.error+']';
            assistantMsg.processState = 'error';
            assistantMsg.processExpanded = true;
          }
        } catch{}
      }
      renderMessages(); scrollMessages();
    }
  } catch(e){
    // Fallback path: retry once without streaming. This avoids losing the final answer
    // when SSE transport drops but the backend can still complete the request.
    try {
      const nonStreamBody = Object.assign({}, body, { stream: false });
      const nonStreamResp = await fetch('/api/chats/'+chatId+'/messages', {
        method:'POST',
        headers,
        body:JSON.stringify(nonStreamBody),
        credentials:'same-origin'
      });
      if(nonStreamResp.ok){
        const payload = await nonStreamResp.json();
        const recoveredMsg = {
          role:'assistant',
          content:String(payload.assistantContent || ''),
          usage:payload.usage || null,
          cost:payload.cost || 0,
          latency_ms:payload.latencyMs || 0,
          created_at:new Date().toISOString(),
          steps:Array.isArray(payload.steps) ? payload.steps : [],
          evalResult:payload.eval || null,
          redaction:payload.redaction || null,
          mode:state.chatSettings?.mode||'direct',
          activeSkills:Array.isArray(payload.activeSkills) ? payload.activeSkills : [],
          enabledTools:Array.isArray(payload.enabledTools) ? payload.enabledTools : [],
          skillTools:Array.isArray(payload.skillTools) ? payload.skillTools : [],
          skillPromptApplied:!!payload.skillPromptApplied,
          processState:'completed',
          processExpanded:false,
          processUi:{detailExpanded:Object.create(null)},
        };
        if(assistantMsg){
          Object.assign(assistantMsg, recoveredMsg);
        } else {
          state.messages.push(recoveredMsg);
        }
        state.streaming=false;
        render();
        return;
      }
    } catch {}

    let recovered = false;
    try {
      const hist = await api.get('/chats/'+chatId+'/messages');
      if(hist.ok){
        const rows = (await hist.json()).messages ?? [];
        const candidates = rows.filter(function(m){
          if(!m || m.role !== 'assistant' || !m.content) return false;
          const ts = Date.parse(m.created_at || '');
          return Number.isFinite(ts) && ts >= (startedAtMs - 15000);
        });
        if(candidates.length){
          const latest = candidates[candidates.length - 1];
          if(assistantMsg){
            assistantMsg.content = String(latest.content || '');
          } else {
            state.messages.push(normalizeLoadedMessage(latest));
          }
          recovered = true;
        }
      }
    } catch {}

    if(!recovered){
      state.messages.push({role:'assistant',content:'[Connection error: '+(e.message||e)+']',created_at:new Date().toISOString()});
    }
  }
  state.streaming=false;
  // Update chat title from first message
  const chat = state.chats.find(c=>c.id===chatId);
  if(chat && chat.title==='New Chat' && text.length>0){
    const newTitle = text.slice(0,40) + (text.length>40?'…':'');
    chat.title = newTitle;
    api.put('/chats/'+chatId,{title:newTitle}).catch((e)=>console.warn('Failed to persist chat title', e));
  }
  render();
}

/* ── Dashboard ──────────────────────────────── */
async function loadDashboard(){
  const [ov,cost,perf,evals,traces,activity] = await Promise.all([
    api.get('/dashboard/overview').then(r=>r.json()),
    api.get('/dashboard/costs').then(r=>r.json()),
    api.get('/dashboard/performance').then(r=>r.json()),
    api.get('/dashboard/evals').then(r=>r.json()),
    api.get('/dashboard/traces?limit=50').then(r=>r.ok?r.json():{traces:[]}).catch(()=>({traces:[]})),
    api.get('/dashboard/agent-activity?limit=50').then(r=>r.ok?r.json():{activity:[]}).catch(()=>({activity:[]})),
  ]);
  state.dashboard = {overview:ov,costs:cost,performance:perf,evals,traces:traces.traces||[],agentActivity:activity.activity||[]};
  render();
  setTimeout(drawCharts, 50);
}

/* ── Drawing charts ─────────────────────────── */
function drawCharts(){
  if(!state.dashboard) return;
  drawBarChart('costModelChart', state.dashboard.costs.byModel||[], m=>m.model, m=>m.cost, '$');
  drawLineChart('costDayChart', state.dashboard.costs.byDay||[], d=>d.date.slice(5), d=>d.cost, '$');
  drawBarChart('latencyChart', state.dashboard.performance.byModel||[], m=>m.model, m=>m.avgLatency, 'ms');
}
function drawBarChart(id,data,labelFn,valueFn,unit){
  const canvas = document.getElementById(id); if(!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio||1;
  canvas.width = canvas.offsetWidth*dpr; canvas.height = 200*dpr;
  ctx.scale(dpr,dpr);
  const W = canvas.offsetWidth, H = 200;
  ctx.clearRect(0,0,W,H);
  if(!data.length){ctx.fillStyle='#737373';ctx.font='13px sans-serif';ctx.fillText('No data yet',W/2-30,H/2);return;}
  const max = Math.max(...data.map(valueFn),1);
  const barW = Math.min(40, (W-40)/data.length - 8);
  const startX = (W - data.length*(barW+8))/2;
  data.forEach((d,i)=>{
    const x = startX + i*(barW+8);
    const val = valueFn(d);
    const barH = (val/max)*(H-50);
    ctx.fillStyle = '#06b6d4';
    ctx.roundRect(x,H-30-barH,barW,barH,4); ctx.fill();
    ctx.beginPath();
    ctx.fillStyle='#a3a3a3'; ctx.font='10px sans-serif'; ctx.textAlign='center';
    ctx.fillText(labelFn(d).slice(0,8),x+barW/2,H-14);
    ctx.fillStyle='#e5e5e5'; ctx.font='11px sans-serif';
    ctx.fillText(unit+(val<1?val.toFixed(4):val.toFixed(2)),x+barW/2,H-34-barH);
  });
}
function drawLineChart(id,data,labelFn,valueFn,unit){
  const canvas = document.getElementById(id); if(!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio||1;
  canvas.width = canvas.offsetWidth*dpr; canvas.height = 200*dpr;
  ctx.scale(dpr,dpr);
  const W = canvas.offsetWidth, H = 200;
  ctx.clearRect(0,0,W,H);
  if(!data.length){ctx.fillStyle='#737373';ctx.font='13px sans-serif';ctx.fillText('No data yet',W/2-30,H/2);return;}
  const max = Math.max(...data.map(valueFn),0.001);
  const pad = 40;
  ctx.strokeStyle='#1e1e1e'; ctx.lineWidth=1;
  for(let i=0;i<5;i++){const y=pad+(H-pad*2)/4*i;ctx.beginPath();ctx.moveTo(pad,y);ctx.lineTo(W-10,y);ctx.stroke();}
  ctx.strokeStyle='#06b6d4'; ctx.lineWidth=2; ctx.beginPath();
  data.forEach((d,i)=>{
    const x = pad + i*((W-pad-10)/(data.length-1||1));
    const y = pad + (1-valueFn(d)/max)*(H-pad*2);
    if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  });
  ctx.stroke();
  ctx.fillStyle='#06b6d4';
  data.forEach((d,i)=>{
    const x = pad + i*((W-pad-10)/(data.length-1||1));
    const y = pad + (1-valueFn(d)/max)*(H-pad*2);
    ctx.beginPath(); ctx.arc(x,y,3,0,Math.PI*2); ctx.fill();
  });
  ctx.fillStyle='#a3a3a3'; ctx.font='10px sans-serif'; ctx.textAlign='center';
  data.forEach((d,i)=>{
    if(data.length>10 && i%Math.ceil(data.length/10)!==0) return;
    const x = pad + i*((W-pad-10)/(data.length-1||1));
    ctx.fillText(labelFn(d),x,H-8);
  });
}

/* ── Scrolling ──────────────────────────────── */
function scrollMessages(){ const el=$('.messages'); if(el) el.scrollTop=el.scrollHeight; }

/* ── Render ─────────────────────────────────── */
function render(){
  const app = $('#app');
  app.innerHTML='';
  document.querySelectorAll('body > .dropdown').forEach(el=>el.remove());
  if(!state.user){ app.appendChild(renderAuth()); return; }
  app.appendChild(renderApp());
}

function shortText(value, maxLen){
  if(value == null) return '';
  const raw = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if(raw.length <= (maxLen || 280)) return raw;
  return raw.slice(0, maxLen || 280) + '...';
}

function detailText(value){
  if(value == null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function summarizeForDisplay(value, maxLen){
  const raw = detailText(value);
  if(!raw) return '';
  const compact = raw.replace(/\\s+/g, ' ').trim();
  if(compact.length <= (maxLen || 180)) return compact;
  return compact.slice(0, maxLen || 180) + '...';
}

function parseJsonMaybe(text){
  if(typeof text !== 'string') return null;
  const trimmed = text.trim();
  if(!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
  try { return JSON.parse(trimmed); } catch(_e){ return null; }
}

function parseDelimitedLine(line, delimiter){
  const cells = [];
  let cell = '';
  let inQuotes = false;
  for(let i=0;i<line.length;i++){
    const ch = line[i];
    if(ch === '"'){
      if(inQuotes && line[i+1] === '"'){
        cell += '"';
        i++;
      }else{
        inQuotes = !inQuotes;
      }
      continue;
    }
    if(ch === delimiter && !inQuotes){
      cells.push(cell.trim());
      cell = '';
      continue;
    }
    cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

function parseDelimitedTable(text){
  if(typeof text !== 'string') return null;
  const lines = text.split(/\\r?\\n/).map(function(line){ return line.trim(); }).filter(Boolean);
  if(lines.length < 2) return null;
  const delimiters = [',', '\\t', '|'];
  for(const delimiter of delimiters){
    const parsed = lines.slice(0, Math.min(lines.length, 40)).map(function(line){ return parseDelimitedLine(line, delimiter); });
    const width = parsed[0]?.length || 0;
    if(width < 2) continue;
    if(!parsed.every(function(row){ return row.length === width; })) continue;
    const headers = parsed[0].map(function(h, idx){ return h || ('col_' + (idx + 1)); });
    const rows = parsed.slice(1);
    if(rows.length < 1) continue;
    return { headers: headers, rows: rows };
  }
  return null;
}

function formatXml(xmlText){
  if(typeof xmlText !== 'string') return null;
  const trimmed = xmlText.trim();
  if(!/^<([A-Za-z_][\\w:.-]*)(\\s|>)/.test(trimmed)) return null;
  try{
    const parser = new DOMParser();
    const parsed = parser.parseFromString(trimmed, 'application/xml');
    if(parsed.getElementsByTagName('parsererror').length) return null;
    const raw = new XMLSerializer().serializeToString(parsed).replace(/>(\\s*)</g, '><');
    const lines = raw.replace(/(>)(<)(\\/?)/g, '$1\\n$2$3').split('\\n');
    let pad = 0;
    return lines.map(function(line){
      const trimmedLine = line.trim();
      if(!trimmedLine) return '';
      if(/^<\\//.test(trimmedLine)) pad = Math.max(0, pad - 1);
      const out = '  '.repeat(pad) + trimmedLine;
      if(/^<[^!?/][^>]*[^/]?>$/.test(trimmedLine)) pad++;
      return out;
    }).filter(Boolean).join('\\n');
  }catch(_e){
    return null;
  }
}

function detectCodeLanguage(text){
  const t = String(text || '');
  if(/(^|\\n)\\s*(SELECT|INSERT|UPDATE|DELETE)\\s+/i.test(t)) return 'sql';
  if(/(^|\\n)\\s*(function|const|let|class|import|export)\\b/.test(t) || /=>/.test(t)) return 'javascript';
  if(/(^|\\n)\\s*(def |class |import |from |if __name__ ==)/.test(t)) return 'python';
  if(/(^|\\n)\\s*(<\\/?[A-Za-z_][\\w:.-]*|<\\?xml)/.test(t)) return 'xml';
  return 'text';
}

function normalizeCodeLanguage(language){
  const lang = String(language || '').trim().toLowerCase();
  if(!lang) return '';
  if(lang === 'py') return 'python';
  if(lang === 'js') return 'javascript';
  if(lang === 'ts') return 'typescript';
  if(lang === 'yml') return 'yaml';
  return lang;
}

function friendlyLanguageName(language){
  const lang = normalizeCodeLanguage(language) || 'text';
  if(lang === 'python') return 'Python';
  if(lang === 'javascript') return 'JavaScript';
  if(lang === 'typescript') return 'TypeScript';
  if(lang === 'sql') return 'SQL';
  if(lang === 'json') return 'JSON';
  if(lang === 'xml') return 'XML';
  if(lang === 'yaml') return 'YAML';
  if(lang === 'bash' || lang === 'shell') return 'Shell';
  return lang.toUpperCase();
}

function looksLikeCode(text){
  if(typeof text !== 'string') return false;
  const trimmed = text.trim();
  if(trimmed.split(/\\r?\\n/).length < 2) return false;
  let score = 0;
  if(/[{};]/.test(trimmed)) score++;
  if(/(^|\\n)\\s*(function|const|let|class|import|export|def|return|if|for|while)\\b/.test(trimmed)) score++;
  if(/=>|<\\/?[A-Za-z]/.test(trimmed)) score++;
  return score >= 2;
}

function tableFromJson(value){
  if(!Array.isArray(value) || !value.length) return null;
  if(!value.every(function(row){ return row && typeof row === 'object' && !Array.isArray(row); })) return null;
  const headers = [];
  value.forEach(function(row){ Object.keys(row).forEach(function(key){ if(!headers.includes(key)) headers.push(key); }); });
  if(headers.length < 2) return null;
  const rows = value.map(function(row){
    return headers.map(function(key){
      const v = row[key];
      if(v == null) return '';
      return typeof v === 'string' ? v : JSON.stringify(v);
    });
  });
  return { headers: headers, rows: rows };
}

function extractCodePayloadFromJson(value){
  if(!value || Array.isArray(value) || typeof value !== 'object') return null;
  const language = normalizeCodeLanguage(value.language || value.lang || value.syntax || value.format);
  const candidates = ['code','source','script','program','content','text','body','query'];
  for(const key of candidates){
    const candidate = value[key];
    if(typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if(!trimmed) continue;
    if(language || looksLikeCode(trimmed) || detectCodeLanguage(trimmed) !== 'text'){
      return {
        code: candidate,
        language: language || detectCodeLanguage(trimmed),
      };
    }
  }
  return null;
}

function renderDetailTable(headers, rows){
  return h('div',{className:'detail-table-wrap'},
    h('table',{className:'detail-table'},
      h('thead',null,
        h('tr',null,
          ...headers.map(function(col){ return h('th',null,col); })
        )
      ),
      h('tbody',null,
        ...rows.map(function(row){
          return h('tr',null,
            ...row.map(function(cell){ return h('td',null,cell == null ? '' : String(cell)); })
          );
        })
      )
    )
  );
}

function renderDetailCode(text, language, kind){
  const codeText = text || '';
  const lang = normalizeCodeLanguage(language) || detectCodeLanguage(codeText);
  const badge = friendlyLanguageName(lang);
  const copyBtn = h('button',{
    className:'detail-copy-btn',
    type:'button',
    title:'Copy code',
    onClick:function(){ copyTextWithFeedback(codeText, copyBtn, 'Copy', 'Copied'); }
  },'Copy');
  return h('div',{className:'detail-block'},
    h('div',{className:'detail-block-hdr'},
      h('span',{className:'detail-lang'},badge),
      h('div',{className:'detail-block-actions'},
        h('span',{className:'detail-kind'},kind || 'formatted'),
        copyBtn
      )
    ),
    h('pre',{className:'detail-code'},codeText)
  );
}

function renderProcessDetailView(value){
  const text = detailText(value);
  if(!text) return h('div',{className:'t-b'},'No detail data');
  const trimmed = text.trim();

  const bt = String.fromCharCode(96);
  const triple = bt + bt + bt;
  if(trimmed.startsWith(triple)){
    const fenceLines = trimmed.split(/\\r?\\n/);
    if(fenceLines.length >= 2 && fenceLines[fenceLines.length - 1] === triple){
      const lang = fenceLines[0].slice(3).trim();
      const body = fenceLines.slice(1, -1).join('\\n');
      return renderDetailCode(body, lang || detectCodeLanguage(body), 'code');
    }
  }

  const json = parseJsonMaybe(trimmed);
  if(json != null){
    const codePayload = extractCodePayloadFromJson(json);
    if(codePayload) return renderDetailCode(codePayload.code, codePayload.language, 'code');
    const table = tableFromJson(json);
    if(table) return renderDetailTable(table.headers, table.rows);
    return renderDetailCode(JSON.stringify(json, null, 2), 'json', 'json');
  }

  const xml = formatXml(trimmed);
  if(xml) return renderDetailCode(xml, 'xml', 'xml');

  const delimited = parseDelimitedTable(trimmed);
  if(delimited) return renderDetailTable(delimited.headers, delimited.rows);

  if(looksLikeCode(trimmed)) return renderDetailCode(trimmed, detectCodeLanguage(trimmed), 'code');

  return h('div',{className:'t-b'},text);
}

function numericValue(v){
  if(typeof v === 'number' && Number.isFinite(v)) return v;
  if(typeof v === 'string'){
    const cleaned = v.replace(/[$,%\s,]/g, '');
    if(!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function normalizeTableData(headers, rows){
  if(!Array.isArray(headers) || !Array.isArray(rows) || !headers.length || !rows.length) return null;
  const normalizedHeaders = headers.map(function(hd, idx){ return String(hd || ('col_' + (idx + 1))); });
  const normalizedRows = rows.map(function(row){
    if(Array.isArray(row)) return row.map(function(cell){ return cell == null ? '' : String(cell); });
    if(row && typeof row === 'object') return normalizedHeaders.map(function(hd){ return row[hd] == null ? '' : String(row[hd]); });
    return [String(row)];
  }).filter(function(row){ return row.length; });
  if(!normalizedRows.length) return null;
  return { headers: normalizedHeaders, rows: normalizedRows };
}

function extractResponseTableData(value){
  if(value == null) return null;
  if(Array.isArray(value)){
    if(!value.length) return null;
    if(value.every(function(row){ return row && typeof row === 'object' && !Array.isArray(row); })){
      const headers = [];
      value.forEach(function(row){ Object.keys(row).forEach(function(key){ if(!headers.includes(key)) headers.push(key); }); });
      const rows = value.map(function(row){
        return headers.map(function(hd){
          const cell = row[hd];
          return cell == null ? '' : (typeof cell === 'string' ? cell : JSON.stringify(cell));
        });
      });
      return normalizeTableData(headers, rows);
    }
    if(value.every(function(row){ return Array.isArray(row); })){
      return normalizeTableData(value[0].map(function(_, idx){ return 'col_' + (idx + 1); }), value);
    }
    return null;
  }
  if(typeof value === 'object'){
    if(value.table && typeof value.table === 'object'){
      const fromTable = extractResponseTableData(value.table);
      if(fromTable) return fromTable;
    }
    if(Array.isArray(value.data)){
      const fromData = extractResponseTableData(value.data);
      if(fromData) return fromData;
    }
    const headers = value.headers || value.columns;
    const rows = value.rows;
    if(Array.isArray(headers) && Array.isArray(rows)) return normalizeTableData(headers, rows);
  }
  return null;
}

function chartSpecFromChartObject(chartObj){
  if(!chartObj || typeof chartObj !== 'object') return null;
  const type = String(chartObj.type || 'bar').toLowerCase();
  let labels = Array.isArray(chartObj.labels) ? chartObj.labels.map(function(x){ return String(x); }) : [];
  let values = Array.isArray(chartObj.values) ? chartObj.values.map(numericValue).filter(function(x){ return x != null; }) : [];
  if((!labels.length || !values.length) && Array.isArray(chartObj.datasets) && chartObj.datasets.length){
    const ds = chartObj.datasets[0] || {};
    labels = labels.length ? labels : (Array.isArray(chartObj.labels) ? chartObj.labels.map(function(x){ return String(x); }) : (Array.isArray(ds.data) ? ds.data.map(function(_, idx){ return 'item_' + (idx + 1); }) : []));
    values = Array.isArray(ds.data) ? ds.data.map(numericValue).filter(function(x){ return x != null; }) : [];
  }
  if(!labels.length || !values.length) return null;
  const len = Math.min(labels.length, values.length, 20);
  return {
    type: type === 'line' ? 'line' : 'bar',
    title: chartObj.title || chartObj.name || 'Chart',
    labels: labels.slice(0, len),
    values: values.slice(0, len),
    unit: chartObj.unit || '',
  };
}

function deriveChartSpecFromTable(tableData, hintTitle, hintType){
  if(!tableData) return null;
  const headers = Array.isArray(tableData.headers) ? tableData.headers : [];
  const rows = Array.isArray(tableData.rows) ? tableData.rows : [];
  if(headers.length < 2 || rows.length < 2) return null;

  const title = String(hintTitle || '').trim();
  const lower = title.toLowerCase();
  const preferred = [];
  if(lower.includes('margin')) preferred.push('margin', '%');
  if(lower.includes('profit')) preferred.push('profit');
  if(lower.includes('revenue') || lower.includes('sales')) preferred.push('revenue', 'sales');
  if(lower.includes('cost') || lower.includes('expense')) preferred.push('cost', 'expense');

  let valueCol = -1;
  const isMostlyNumeric = function(colIdx){
    const numericCount = rows.reduce(function(acc, row){ return acc + (numericValue(row[colIdx]) != null ? 1 : 0); }, 0);
    return numericCount >= Math.max(2, Math.floor(rows.length * 0.6));
  };

  for(const key of preferred){
    const idx = headers.findIndex(function(hd){ return String(hd || '').toLowerCase().includes(key); });
    if(idx > 0 && isMostlyNumeric(idx)){ valueCol = idx; break; }
  }

  if(valueCol < 0){
    for(let c=1;c<headers.length;c++){
      if(isMostlyNumeric(c)){ valueCol = c; break; }
    }
  }
  if(valueCol < 0) return null;

  const points = rows.map(function(row){
    return { label: String(row[0] || ''), value: numericValue(row[valueCol]) };
  }).filter(function(point){ return point.label && point.value != null; }).slice(0, 20);
  if(points.length < 2) return null;

  return {
    type: String(hintType || '').toLowerCase() === 'line' ? 'line' : 'bar',
    title: title || (headers[valueCol] + ' by ' + headers[0]),
    labels: points.map(function(p){ return p.label; }),
    values: points.map(function(p){ return p.value; }),
    unit: '',
  };
}

function extractResponseChartSpecs(value, tableData){
  const specs = [];
  if(value && typeof value === 'object' && value.chart){
    const chartEntries = Array.isArray(value.chart) ? value.chart : [value.chart];
    chartEntries.forEach(function(entry){
      const explicit = chartSpecFromChartObject(entry);
      if(explicit){
        specs.push(explicit);
        return;
      }
      const fallback = deriveChartSpecFromTable(tableData, entry?.title || entry?.name || '', entry?.type || 'bar');
      if(fallback) specs.push(fallback);
    });
  }

  if(!specs.length){
    const single = extractResponseChartSpec(value, tableData);
    if(single) specs.push(single);
  }
  return specs;
}

function extractResponseChartSpec(value, tableData){
  if(value && typeof value === 'object' && value.chart){
    const explicit = chartSpecFromChartObject(value.chart);
    if(explicit) return explicit;
  }

  return deriveChartSpecFromTable(tableData, '', 'bar');
}

function renderResponseTable(headers, rows){
  return h('div',{className:'response-table-wrap'},
    h('table',{className:'response-table'},
      h('thead',null,
        h('tr',null,
          ...headers.map(function(col){ return h('th',null,col); })
        )
      ),
      h('tbody',null,
        ...rows.map(function(row){
          return h('tr',null,
            ...row.map(function(cell){ return h('td',null,cell == null ? '' : String(cell)); })
          );
        })
      )
    )
  );
}

function renderResponseChart(spec){
  const labels = Array.isArray(spec?.labels) ? spec.labels : [];
  const values = Array.isArray(spec?.values) ? spec.values : [];
  if(!labels.length || !values.length) return null;
  const max = Math.max.apply(null, values.concat([0.0001]));
  const unit = spec.unit ? String(spec.unit) : '';
  const title = spec.title || 'Chart';
  if(spec.type === 'line'){
    const width = 560;
    const height = 180;
    const pad = 20;
    const xSpan = Math.max(1, labels.length - 1);
    const points = values.map(function(v, idx){
      const x = pad + ((width - pad * 2) * idx / xSpan);
      const y = pad + ((height - pad * 2) * (1 - (v / max)));
      return { x:x, y:y };
    });
    const path = points.map(function(p, idx){ return (idx === 0 ? 'M' : 'L') + p.x + ' ' + p.y; }).join(' ');
    return h('div',{className:'response-chart response-line'},
      h('div',{className:'response-chart-title'},title),
      h('svg',{viewBox:'0 0 ' + width + ' ' + height, preserveAspectRatio:'none'},
        h('line',{className:'response-line-axis',x1:String(pad),y1:String(height - pad),x2:String(width - pad),y2:String(height - pad)}),
        h('path',{className:'response-line-path',d:path}),
        ...points.map(function(p){ return h('circle',{className:'response-line-dot',cx:String(p.x),cy:String(p.y),r:'2.5'}); })
      ),
      h('div',{className:'response-line-labels'},
        ...labels.map(function(label){ return h('span',null,label); })
      )
    );
  }
  return h('div',{className:'response-chart'},
    h('div',{className:'response-chart-title'},title),
    h('div',{className:'response-bars'},
      ...labels.map(function(label, idx){
        const value = values[idx];
        const widthPct = Math.max(2, Math.round((value / max) * 100));
        return h('div',{className:'response-bar-row'},
          h('div',{className:'response-bar-label',title:label},label),
          h('div',{className:'response-bar-track'},
            h('div',{className:'response-bar-fill',style:'width:' + widthPct + '%'})
          ),
          h('div',{className:'response-bar-value'},String(value) + unit)
        );
      })
    )
  );
}

function renderAssistantStructuredContent(content){
  const text = String(content || '');
  const trimmed = text.trim();
  if(!trimmed) return null;

  const json = parseJsonMaybe(trimmed);
  if(json != null){
    const codePayload = extractCodePayloadFromJson(json);
    if(codePayload){
      return h('div',{className:'response-rich'},
        renderDetailCode(codePayload.code, codePayload.language, 'code')
      );
    }
    const table = extractResponseTableData(json);
    const charts = extractResponseChartSpecs(json, table);
    const note = typeof json.summary === 'string' ? json.summary : typeof json.message === 'string' ? json.message : typeof json.description === 'string' ? json.description : '';
    if(charts.length || table){
      return h('div',{className:'response-rich'},
        note ? h('p',{className:'response-note'},note) : null,
        ...charts.map(function(spec){ return renderResponseChart(spec); }),
        table ? renderResponseTable(table.headers, table.rows) : null
      );
    }
  }

  const delimited = parseDelimitedTable(trimmed);
  if(delimited){
    return h('div',{className:'response-rich'},
      renderResponseTable(delimited.headers, delimited.rows)
    );
  }
  return null;
}

function extractJsonCodeBlocks(text){
  const bt = String.fromCharCode(96);
  const triple = bt + bt + bt;
  if(typeof text !== 'string' || !text.includes(triple)) return { blocks: [], stripped: text || '' };
  const fenceRe = new RegExp(triple + '([^\\n' + bt + ']*)\\n([\\s\\S]*?)' + triple, 'g');
  const blocks = [];
  let stripped = '';
  let lastIndex = 0;
  let match;
  while((match = fenceRe.exec(text))){
    const language = String(match[1] || '').trim().toLowerCase();
    const body = String(match[2] || '').trim();
    const parsed = parseJsonMaybe(body);
    if(parsed == null) continue;
    if(language && language !== 'json' && language !== 'application/json' && language !== 'chart' && language !== 'table') continue;
    blocks.push(parsed);
    stripped += text.slice(lastIndex, match.index);
    lastIndex = fenceRe.lastIndex;
  }
  if(!blocks.length) return { blocks: [], stripped: text };
  stripped += text.slice(lastIndex);
  return { blocks: blocks, stripped: stripped };
}

function renderAssistantEmbeddedStructuredContent(content){
  const extracted = extractJsonCodeBlocks(content);
  if(!extracted.blocks.length) return null;
  const sections = [];
  extracted.blocks.forEach(function(block){
    const table = extractResponseTableData(block);
    const chart = extractResponseChartSpec(block, table);
    const note = typeof block?.summary === 'string' ? block.summary : typeof block?.message === 'string' ? block.message : typeof block?.description === 'string' ? block.description : '';
    if(!chart && !table) return;
    sections.push(
      h('div',{className:'response-rich'},
        note ? h('p',{className:'response-note'},note) : null,
        chart ? renderResponseChart(chart) : null,
        table ? renderResponseTable(table.headers, table.rows) : null
      )
    );
  });
  if(!sections.length) return null;
  return {
    markdown: String(extracted.stripped || '').trim(),
    node: h('div',{className:'response-rich response-rich-embedded'},sections),
  };
}

function parseMarkdownListValues(text){
  if(typeof text !== 'string') return [];
  return text.split(',').map(function(part){ return part.trim(); }).filter(Boolean);
}

function parseMarkdownChartSpecs(text){
  if(typeof text !== 'string' || !text.trim()) return [];
  const lines = text.split(/\\r?\\n/);
  const charts = [];
  for(let i=0;i<lines.length;i++){
    const typeMatch = lines[i].trim().match(/^(?:[-*]\\s*)?Type:\\s*(bar|line)\\b/i);
    if(!typeMatch) continue;
    const type = String(typeMatch[1] || 'bar').toLowerCase();
    let labels = [];
    let values = [];
    for(let j=i+1;j<Math.min(lines.length, i+7);j++){
      const line = lines[j].trim();
      const labelsMatch = line.match(/^(?:[-*]\\s*)?Labels:\\s*(.+)$/i);
      if(labelsMatch) labels = parseMarkdownListValues(labelsMatch[1]);
      const valuesMatch = line.match(/^(?:[-*]\\s*)?Values:\\s*(.+)$/i);
      if(valuesMatch) values = parseMarkdownListValues(valuesMatch[1]).map(numericValue).filter(function(v){ return v != null; });
    }
    if(labels.length < 2 || values.length < 2) continue;
    const len = Math.min(labels.length, values.length, 20);

    let title = 'Chart';
    for(let p=i-1;p>=Math.max(0, i-4);p--){
      const candidate = lines[p].trim();
      if(!candidate) continue;
      if(/^(charts?|summary table)$/i.test(candidate.replace(/:$/, ''))) continue;
      if(/^(?:[-*]\\s*)?(type|labels|values):/i.test(candidate)) continue;
      title = candidate
        .replace(/^\\d+\\.\\s*/, '')
        .replace(/^[-*]\\s*/, '')
        .replace(/^[#>]+\\s*/, '')
        .trim();
      if(title) break;
    }

    charts.push({
      type: type === 'line' ? 'line' : 'bar',
      title: title || 'Chart',
      labels: labels.slice(0, len),
      values: values.slice(0, len),
      unit: '',
    });
  }
  return charts;
}

function renderAssistantMarkdownCharts(content){
  const charts = parseMarkdownChartSpecs(content);
  if(!charts.length) return null;
  return h('div',{className:'response-rich response-rich-embedded'},
    charts.map(function(spec){ return renderResponseChart(spec); })
  );
}

function renderAssistantBubble(content){
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  const structured = renderAssistantStructuredContent(content);
  if(structured){
    bubble.appendChild(structured);
  }else{
    const embedded = renderAssistantEmbeddedStructuredContent(content || '');
    if(embedded){
      const markdown = mdToHtml(embedded.markdown || '');
      if(markdown) bubble.innerHTML = markdown;
      bubble.appendChild(embedded.node);
    }else{
      bubble.innerHTML = mdToHtml(content || '');
      const markdownCharts = renderAssistantMarkdownCharts(content || '');
      if(markdownCharts) bubble.appendChild(markdownCharts);
    }
  }
  return {
    element: bubble,
    exportHtml: bubble.innerHTML,
  };
}

function processStageMeta(stage){
  if(stage === 'error') return { label:'Error', icon:'!', tone:'deny' };
  if(stage === 'completed') return { label:'Completed', icon:'✓', tone:'ok' };
  if(stage === 'validating') return { label:'Validating', icon:'◉', tone:'warn' };
  if(stage === 'tools') return { label:'Using Tools', icon:'⚙', tone:'ok' };
  if(stage === 'finalizing') return { label:'Finalizing', icon:'↗', tone:'ok' };
  return { label:'Thinking', icon:'…', tone:'ok' };
}

function ensureProcessUiState(msg){
  if(!msg.processUi || typeof msg.processUi !== 'object'){
    msg.processUi = { detailExpanded: Object.create(null) };
  }
  if(!msg.processUi.detailExpanded || typeof msg.processUi.detailExpanded !== 'object'){
    msg.processUi.detailExpanded = Object.create(null);
  }
  return msg.processUi;
}

function toggleProcessDetail(msg, key){
  const ui = ensureProcessUiState(msg);
  ui.detailExpanded[key] = !ui.detailExpanded[key];
}

function processStatusTone(status){
  if(status === 'deny' || status === 'fail' || status === 'error') return 'deny';
  if(status === 'warn' || status === 'redacted') return 'warn';
  return 'ok';
}

function extractThoughtText(step){
  if(!step) return '';
  if(step.type === 'thinking') return String(step.text || step.content || '').trim();
  const toolName = step?.toolCall?.name || step?.name || step?.toolName || '';
  if(toolName !== 'think') return '';
  const args = step?.toolCall?.arguments ?? step?.input;
  const result = step?.toolCall?.result ?? step?.result;
  if(typeof result === 'string' && result.trim()){
    return result.replace(/^\[(PLANNING|REASONING|SYNTHESIS|REFLECTION)\]\\s*/,'').trim();
  }
  if(typeof args === 'string' && args.trim()) return args.trim();
  if(args && typeof args === 'object'){
    const candidate = args.reasoning || args.thought || args.content || args.summary || args.prompt || args.goal;
    if(typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

function buildProcessViewModel(msg, isStreamingCurrent){
  const steps = Array.isArray(msg.steps) ? msg.steps : [];
  const thoughtHistory = [];
  const timeline = [];
  const skills = Array.isArray(msg.activeSkills) ? msg.activeSkills : [];
  const skillEffects = [];
  const validations = [];

  steps.forEach(function(s, idx){
    const stepType = s?.type || s?.kind || 'step';
    const thoughtText = extractThoughtText(s);
    if(thoughtText){
      thoughtHistory.push({ text: thoughtText, idx: idx + 1 });
      timeline.push({
        kind: 'thought',
        title: 'Thought update',
        summary: summarizeForDisplay(thoughtText, 220),
        raw: detailText(thoughtText),
        detailLabel: 'thought',
        durationMs: s?.durationMs,
        key: 'thought-' + idx,
      });
      if(stepType === 'thinking' || (s?.toolCall?.name || s?.name || s?.toolName) === 'think') return;
    }

    if(stepType === 'thinking'){
      return;
    }

    if(s?.kind === 'tool_start' || stepType === 'tool_call'){
      const toolName = s?.name || s?.toolName || s?.toolCall?.name || 'tool';
      const input = s?.input ?? s?.toolCall?.arguments;
      const result = s?.result ?? s?.toolCall?.result;
      timeline.push({
        kind: 'tool',
        title: 'Tool: ' + toolName,
        summary: result != null
          ? 'Input: ' + summarizeForDisplay(input, 120) + '\\nOutput: ' + summarizeForDisplay(result, 160)
          : 'Input: ' + summarizeForDisplay(input, 180),
        inputRaw: detailText(input),
        outputRaw: detailText(result),
        durationMs: s?.durationMs,
        key: 'tool-' + idx,
      });
      return;
    }

    if(stepType === 'delegation'){
      timeline.push({
        kind: 'delegation',
        title: 'Delegated to: ' + (s?.worker || s?.name || 'worker'),
        summary: summarizeForDisplay(s?.input || s?.message || s?.delegation || '', 220),
        raw: detailText(s?.input || s?.message || s?.delegation || ''),
        detailLabel: 'delegation',
        durationMs: s?.durationMs,
        key: 'delegation-' + idx,
      });
      return;
    }

    timeline.push({
      kind: stepType === 'response' ? 'response' : 'step',
      title: stepType,
      summary: summarizeForDisplay(s?.text || s?.content || s, 220),
      raw: detailText(s?.text || s?.content || s),
      detailLabel: stepType === 'response' ? 'response' : 'event',
      durationMs: s?.durationMs,
      key: stepType + '-' + idx,
    });
  });

  const liveThought = thoughtHistory.length ? thoughtHistory[thoughtHistory.length - 1].text : '';
  if(msg?.skillPromptApplied) skillEffects.push('Prompt guidance injected');
  if(Array.isArray(msg?.skillTools) && msg.skillTools.length){
    msg.skillTools.forEach(function(tool){ skillEffects.push('Enabled: ' + tool); });
  }

  if(msg?.redaction){
    const redactedCount = msg.redaction.count || msg.redaction.detections?.length || 0;
    validations.push({
      kind: 'redaction',
      label: 'Redaction',
      status: redactedCount > 0 ? 'warn' : 'ok',
      summary: redactedCount > 0 ? ('Redacted ' + redactedCount + ' item' + (redactedCount === 1 ? '' : 's')) : 'No sensitive content flagged',
    });
  }

  if(msg?.evalResult){
    const score = msg.evalResult.score != null ? Math.round(Number(msg.evalResult.score) * 100) : null;
    const passed = msg.evalResult.passed ?? msg.evalResult.score >= 1;
    validations.push({
      kind: 'eval',
      label: 'Evaluation',
      status: passed ? 'ok' : 'warn',
      summary: 'Score ' + (score != null ? (score + '%') : 'n/a') + ' • Passed ' + (msg.evalResult.passed ?? 'n/a') + ' • Failed ' + (msg.evalResult.failed ?? 'n/a'),
    });
  }

  if(msg?.cognitive){
    const confidence = Math.round((msg.cognitive.confidence || 0) * 100);
    const decision = msg.cognitive.decision || 'allow';
    const firstWarn = msg.cognitive.checks?.find(function(x){ return x.decision !== 'allow'; });
    validations.push({
      kind: 'cognitive',
      label: 'Cognitive Check',
      status: decision,
      summary: 'Confidence ' + confidence + '% • ' + decision + (firstWarn?.explanation ? (' • ' + firstWarn.explanation) : ''),
    });
  }

  if(msg?.guardrail){
    const guardrailDecision = msg.guardrail.decision || 'allow';
    validations.push({
      kind: 'guardrail',
      label: 'Guardrail',
      status: guardrailDecision,
      summary: guardrailDecision + (msg.guardrail.reason ? (' • ' + msg.guardrail.reason) : ''),
    });
  }

  let stage = 'thinking';
  if(msg?.processState === 'error') stage = 'error';
  else if(!isStreamingCurrent && (msg?.processState === 'completed' || !!msg?.content)) stage = 'completed';
  else if(isStreamingCurrent && msg?.content) stage = 'finalizing';
  else if(validations.length) stage = 'validating';
  else if(timeline.length) stage = 'tools';

  const toolCount = timeline.filter(function(item){ return item.kind === 'tool' || item.kind === 'delegation'; }).length;
  const validationTone = validations.length
    ? validations.some(function(item){ return processStatusTone(item.status) === 'deny'; })
      ? 'deny'
      : validations.some(function(item){ return processStatusTone(item.status) === 'warn'; })
        ? 'warn'
        : 'ok'
    : null;
  const summaryChips = [];
  if(skills.length) summaryChips.push({ label:'Skills: ' + skills.length, tone:'ok' });
  if(toolCount) summaryChips.push({ label:'Tools: ' + toolCount, tone:'ok' });
  if(validations.length) summaryChips.push({ label:'Checks: ' + validationTone, tone:validationTone });
  if(msg?.latency_ms) summaryChips.push({ label:'Duration: ' + msg.latency_ms + 'ms', tone:'ok' });

  const hasProcess = isStreamingCurrent || thoughtHistory.length > 0 || timeline.length > 0 || skills.length > 0 || validations.length > 0;

  return {
    hasProcess,
    stage,
    liveThought,
    thoughtCount: thoughtHistory.length,
    timeline,
    skills,
    skillEffects,
    validations,
    summaryChips,
    expanded: typeof msg.processExpanded === 'boolean' ? msg.processExpanded : isStreamingCurrent,
  };
}

function renderMessages(){
  const container = $('.messages');
  if(!container) return;
  container.innerHTML='';
  if(!state.messages.length){
    const logoSvg=document.createElement('div');logoSvg.className='logo';logoSvg.innerHTML='<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#8A8A8A" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 10h.01"/><path d="M12 10h.01"/><path d="M16 10h.01"/></svg>';
    container.appendChild(h('div',{className:'empty-chat'},
      logoSvg,
      h('div',null,'Start a conversation with geneWeave'),
      h('div',null,'Choose a model above and type your message')
    ));
    return;
  }
  state.messages.forEach((m, msgIndex)=>{
    const isUser = m.role==='user';
    const extras = [];
    const attachments = Array.isArray(m.attachments) ? m.attachments : [];
    const isStreamingCurrent = !isUser && state.streaming && msgIndex === state.messages.length - 1;

    if(!isUser && m.mode && m.mode!=='direct'){
      extras.push(h('span',{className:'mode-badge'},m.mode));
    }
    if(!isUser){
      const processUi = ensureProcessUiState(m);
      const process = buildProcessViewModel(m, isStreamingCurrent);
      if(process.hasProcess){
        const stageMeta = processStageMeta(process.stage);
        const stageLabel = stageMeta.label || 'Running';
        const summary = process.timeline.length + ' events' + (process.thoughtCount ? ' • ' + process.thoughtCount + ' thought updates' : '');
        const toggleText = process.expanded ? 'Hide details' : 'Show details';

        const skillCards = process.skills.map(function(skill){
          const scorePct = Math.max(0, Math.min(100, Math.round(Number(skill.score || 0) * 100)));
          const skillTools = Array.isArray(skill.tools) ? skill.tools : [];
          return h('div',{className:'skill-item'},
            h('div',{className:'skill-item-top'},
              h('span',{className:'skill-name'},skill.name || skill.id || 'Unnamed skill'),
              h('span',{className:'skill-score'},scorePct + '% match')
            ),
            h('div',{className:'skill-category'},String(skill.category || 'general').replace(/_/g,' ')),
            skillTools.length ? h('div',{className:'skill-tags'},
              ...skillTools.map(function(t){ return h('span',{className:'skill-tag'},t); })
            ) : null
          );
        });

        const validationRows = process.validations.map(function(item){
          const tone = processStatusTone(item.status);
          const statusIcon = tone === 'deny' ? '✕' : tone === 'warn' ? '!' : '✓';
          return h('div',{className:'validation-item ' + tone},
            h('div',{className:'validation-item-top'},
              h('span',{className:'validation-name'},item.label),
              h('span',{className:'validation-status ' + tone},statusIcon + ' ' + String(item.status || 'ok'))
            ),
            h('div',{className:'validation-body'},item.summary || '')
          );
        });

        const processBody = h('div',{className:'process-body'},
          h('div',{className:'live-thought'},
            h('div',{className:'lbl'},'Current thought'),
            h('div',{className:'txt'},process.liveThought || (isStreamingCurrent ? 'Thinking...' : 'No thought trace captured.'))
          ),
          process.skills.length ? h('div',{className:'process-section'},
            h('div',{className:'process-section-title'},'\u2728 Skills Invoked'),
            h('div',{className:'skill-list'},...skillCards),
            process.skillEffects.length ? h('div',{className:'skill-summary'},
              ...process.skillEffects.map(function(effect){ return h('span',{className:'skill-tag'},effect); })
            ) : null
          ) : null,
          process.timeline.length ? h('div',{className:'timeline'},
            ...process.timeline.map(function(item, idx){
              const dur = item.durationMs != null ? item.durationMs + 'ms' : '';
              const keyBase = item.key || ('timeline-' + idx);
              const showRaw = !!processUi.detailExpanded[keyBase + '-raw'];
              const showInput = !!processUi.detailExpanded[keyBase + '-input'];
              const showOutput = !!processUi.detailExpanded[keyBase + '-output'];
              return h('div',{className:'timeline-item ' + item.kind},
                h('div',{className:'t-h'},
                  h('span',null,item.title || ('Event ' + (idx + 1))),
                  h('span',null,dur)
                ),
                item.summary ? h('div',{className:'t-summary'},item.summary) : null,
                (item.raw || item.inputRaw || item.outputRaw) ? h('div',{className:'t-actions'},
                  item.raw ? h('button',{
                    className:'detail-toggle',
                    type:'button',
                    'aria-expanded':String(showRaw),
                    'aria-controls':'process-' + msgIndex + '-' + keyBase + '-raw',
                    onClick:function(){ toggleProcessDetail(m, keyBase + '-raw'); renderMessages(); }
                  },showRaw ? 'Hide raw ' + (item.detailLabel || 'details') : 'View raw ' + (item.detailLabel || 'details')) : null,
                  item.inputRaw ? h('button',{
                    className:'detail-toggle',
                    type:'button',
                    'aria-expanded':String(showInput),
                    'aria-controls':'process-' + msgIndex + '-' + keyBase + '-input',
                    onClick:function(){ toggleProcessDetail(m, keyBase + '-input'); renderMessages(); }
                  },showInput ? 'Hide input' : 'View input') : null,
                  item.outputRaw ? h('button',{
                    className:'detail-toggle',
                    type:'button',
                    'aria-expanded':String(showOutput),
                    'aria-controls':'process-' + msgIndex + '-' + keyBase + '-output',
                    onClick:function(){ toggleProcessDetail(m, keyBase + '-output'); renderMessages(); }
                  },showOutput ? 'Hide output' : 'View output') : null
                ) : null,
                item.raw && showRaw ? h('div',{className:'t-raw',id:'process-' + msgIndex + '-' + keyBase + '-raw'},
                  h('div',{className:'t-raw-label'},'Raw ' + (item.detailLabel || 'details')),
                  renderProcessDetailView(item.raw)
                ) : null,
                item.inputRaw && showInput ? h('div',{className:'t-raw',id:'process-' + msgIndex + '-' + keyBase + '-input'},
                  h('div',{className:'t-raw-label'},'Tool input'),
                  renderProcessDetailView(item.inputRaw)
                ) : null,
                item.outputRaw && showOutput ? h('div',{className:'t-raw',id:'process-' + msgIndex + '-' + keyBase + '-output'},
                  h('div',{className:'t-raw-label'},'Tool output'),
                  renderProcessDetailView(item.outputRaw)
                ) : null
              );
            })
          ) : null,
          process.validations.length ? h('div',{className:'process-section'},
            h('div',{className:'process-section-title'},'Validation'),
            h('div',{className:'validation-list'},...validationRows)
          ) : null
        );

        extras.push(h('div',{className:'process-card ' + (m.processState || process.stage)},
          h('div',{className:'process-hdr'},
            h('div',{className:'process-hdr-main'},
              h('div',{className:'process-title'},
                h('span',null,'\u{1F9E0} Process'),
                h('span',{className:'process-stage ' + stageMeta.tone,role:'status','aria-live':'polite','aria-atomic':'true'},
                  h('span',{className:'process-stage-icon','aria-hidden':'true'},stageMeta.icon),
                  h('span',null,stageLabel)
                )
              ),
              !process.expanded && process.summaryChips.length ? h('div',{className:'process-meta'},
                ...process.summaryChips.map(function(chip){
                  return h('span',{className:'summary-chip ' + (chip.tone || 'ok')},chip.label);
                })
              ) : null
            ),
            h('button',{className:'process-toggle',type:'button','aria-expanded':String(process.expanded),'aria-controls':'process-body-' + msgIndex,onClick:function(){ m.processExpanded = !process.expanded; renderMessages(); }},toggleText)
          ),
          !process.expanded ? h('div',{className:'process-summary'},
            h('div',null,summary || 'No process events'),
            process.summaryChips.length ? h('div',{className:'process-meta'},
              ...process.summaryChips.map(function(chip){
                return h('span',{className:'summary-chip ' + (chip.tone || 'ok')},chip.label);
              })
            ) : null
          ) : null,
          h('div',{className:'process-body-wrap ' + (process.expanded ? 'expanded' : 'collapsed'),id:'process-body-' + msgIndex,'aria-hidden':String(!process.expanded)},
            h('div',{className:'process-body-clip'},processBody)
          )
        ));
      }
    }
    let corner = null;
    if(!isUser){
      const indicators = [];
      if(m.evalResult){
        const score = m.evalResult.score != null ? (m.evalResult.score*100).toFixed(0) : null;
        const passed = m.evalResult.passed ?? m.evalResult.score >= 1;
        indicators.push(h('div',{
          className:'resp-ind '+(passed?'ok':'warn'),
          title:'Eval score: '+(score?score+'%':'n/a')+' | Passed: '+(m.evalResult.passed??'n/a')+' Failed: '+(m.evalResult.failed??'n/a'),
        },passed?'\\u2713':'!'));
      }
      if(m.cognitive){
        const c = Math.round((m.cognitive.confidence||0) * 100);
        const decision = m.cognitive.decision || 'allow';
        const firstWarn = m.cognitive.checks?.find(x=>x.decision!=='allow');
        indicators.push(h('div',{
          className:'resp-ind '+(decision==='deny'?'deny':decision==='warn'?'warn':'ok'),
          title:'Confidence: '+c+'% | Cognitive decision: '+decision+(firstWarn?.explanation?' | '+firstWarn.explanation:''),
        },'\\u25C9'));
      }
      if(m.guardrail){
        const gd = m.guardrail.decision;
        indicators.push(h('div',{
          className:'resp-ind '+(gd==='deny'?'deny':gd==='warn'?'warn':'ok'),
          title:'Guardrail: '+gd+(m.guardrail.reason?' | '+m.guardrail.reason:''),
        },gd==='deny'?'\\u2715':gd==='warn'?'\\u26A0':'\\u2713'));
      }
      if(indicators.length) corner = h('div',{className:'resp-corner'},...indicators);
    }

    // Build bubble element
    let bubbleEl;
    let responseExportHtml = '';
    if(!isUser && m.content){
      const renderedBubble = renderAssistantBubble(m.content);
      bubbleEl = renderedBubble.element;
      responseExportHtml = renderedBubble.exportHtml;
    } else {
      bubbleEl = h('div',{className:'bubble'},m.content||(state.streaming?'':'...'));
    }

    // Action toolbar for assistant messages
    const toolbar = !isUser && m.content ? (()=>{
      const rawText = m.content;
      const richHtml = responseExportHtml || mdToHtml(m.content);
      const bar = document.createElement('div');
      bar.className = 'response-toolbar';
      // Copy
      const copyBtn = document.createElement('button');
      copyBtn.className = 'tb-btn';
      copyBtn.innerHTML = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span class="tb-label">Copy</span>';
      copyBtn.onclick = ()=> copyResponse(rawText, copyBtn);
      // Email
      const emailBtn = document.createElement('button');
      emailBtn.className = 'tb-btn';
      emailBtn.innerHTML = '<svg viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg><span class="tb-label">Email</span>';
      emailBtn.onclick = ()=> emailResponse(rawText, 'geneWeave Response');
      // Word
      const wordBtn = document.createElement('button');
      wordBtn.className = 'tb-btn';
      wordBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg><span class="tb-label">Word</span>';
      wordBtn.onclick = ()=> openInWord(richHtml, rawText);
      bar.appendChild(copyBtn);
      bar.appendChild(emailBtn);
      bar.appendChild(wordBtn);
      return bar;
    })() : null;

    // Determine avatar image for this message
    var avatarEl;
    if(isUser){
      var img = document.createElement('img');
      img.src = getUserAvatarUrl();
      img.alt = 'User';
      avatarEl = h('div',{className:'avatar'},img);
    } else {
      // For assistant: check if a specific agent name is in the steps
      var agentName = '';
      if(m.steps){
        for(var si=0;si<m.steps.length;si++){
          var st=m.steps[si];
          if(st.type==='delegation'&&(st.worker||st.name)){ agentName=st.worker||st.name; break; }
          if(st.type==='tool_call'&&st.toolCall?.name==='delegate_to_worker'&&st.toolCall?.arguments?.worker){
            agentName=st.toolCall.arguments.worker;
            break;
          }
        }
      }
      var aImg = document.createElement('img');
      aImg.src = getAgentAvatarUrl(agentName);
      aImg.alt = agentName||'Agent';
      avatarEl = h('div',{className:'avatar'},aImg);
    }

    // Render screenshots if any
    let screenshotsEl = null;
    if(!isUser && m.screenshots && m.screenshots.length){
      const imgs = m.screenshots.map(function(s){
        const img = document.createElement('img');
        img.src = 'data:image/'+(s.format||'png')+';base64,'+s.base64;
        img.className = 'screenshot-img';
        img.style.cssText = 'max-width:100%;border-radius:8px;margin-top:8px;border:1px solid var(--border);cursor:pointer;';
        img.onclick = function(){ window.open(img.src, '_blank'); };
        img.title = 'Click to open full size';
        return img;
      });
      screenshotsEl = h('div',{className:'screenshots'},...imgs);
    }

    let attachmentsEl = null;
    if(attachments.length){
      const nodes = attachments.map(function(att){
        const mime = String(att.mimeType || 'application/octet-stream');
        const title = String(att.name || 'attachment');
        const base64 = typeof att.dataBase64 === 'string' ? att.dataBase64 : '';
        const dataUrl = base64 ? ('data:'+mime+';base64,'+base64) : null;
        const transcript = typeof att.transcript === 'string' ? att.transcript : '';

        const body = [
          h('div',{className:'title'},title),
          h('div',null,mime+' • '+((att.size||0)+' bytes')),
        ];
        if(transcript){
          body.push(h('pre',null,transcript));
        }
        if(dataUrl && mime.startsWith('audio/')){
          body.push(h('audio',{controls:true,src:dataUrl}));
        }
        if(dataUrl && mime.startsWith('image/')){
          const img = h('img',{src:dataUrl,style:'max-width:100%;border-radius:8px;margin-top:6px'});
          body.push(img);
        }
        if(dataUrl && !mime.startsWith('audio/') && !mime.startsWith('image/')){
          body.push(h('a',{href:dataUrl,download:title,target:'_blank',rel:'noopener'},'Download attachment'));
        }
        return h('div',{className:'msg-attachment'},...body);
      });
      attachmentsEl = h('div',{className:'msg-attachments'},...nodes);
    }

    const msgEl = h('div',{className:'msg '+(isUser?'user':'assistant')},
      avatarEl,
      h('div',{className:'msg-body'},
        corner,
        ...extras,
        bubbleEl,
        attachmentsEl,
        screenshotsEl,
        toolbar,
        !isUser && m.usage ? h('div',{className:'meta'},
          h('span',null,'\\u{1F4CA} '+m.usage.totalTokens+' tok'),
          h('span',null,'\\u{1F4B0} $'+(m.cost||0).toFixed(6)),
          h('span',null,'\\u23F1 '+(m.latency_ms||0)+'ms')
        ) : null,
        !isUser && state.streaming && !m.content ? h('div',{className:'streaming-indicator'},h('span',null,'.'),h('span',null,'.'),h('span',null,'.')) : null
      )
    );
    container.appendChild(msgEl);
  });
}

function renderAuth(){
  const isLogin = state.authMode==='login';
  const card = h('div',{className:'auth-wrap'},
    h('div',{className:'auth-card'},
      h('h1',null,Object.assign(document.createElement('span'),{innerHTML:'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#8A8A8A" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px;margin-right:6px"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 10h.01"/><path d="M12 10h.01"/><path d="M16 10h.01"/></svg>'}),' ',h('span',null,'gene'),('Weave')),
      h('p',{className:'sub'},isLogin?'Sign in to your account':'Create a new account'),
      !isLogin ? h('div',{className:'field'},h('label',null,'Name'),h('input',{type:'text',id:'auth-name',placeholder:'Your name'})) : null,
      h('div',{className:'field'},h('label',null,'Email'),h('input',{type:'email',id:'auth-email',placeholder:'you@example.com'})),
      h('div',{className:'field'},h('label',null,'Password'),h('input',{type:'password',id:'auth-pass',placeholder:'\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022'})),
      h('button',{className:'btn',onClick:()=>{
        const email=$('#auth-email').value;
        const pass=$('#auth-pass').value;
        if(isLogin) doLogin(email,pass);
        else doRegister($('#auth-name').value,email,pass);
      }},isLogin?'Sign In':'Create Account'),
      h('div',{className:'divider'},h('div',{className:'line'}),h('span',null,'or'),h('div',{className:'line'})),
      h('div',{className:'oauth-btns'},
        h('button',{className:'oauth-btn',onClick:()=>initiateOAuthFlow('google'),title:'Sign in with Google'},h('span',null,'🔷'),'Google'),
        h('button',{className:'oauth-btn',onClick:()=>initiateOAuthFlow('github'),title:'Sign in with GitHub'},h('span',null,'⬛'),'GitHub'),
        h('button',{className:'oauth-btn',onClick:()=>initiateOAuthFlow('microsoft'),title:'Sign in with Microsoft'},h('span',null,'🟦'),'Microsoft'),
        h('button',{className:'oauth-btn',onClick:()=>initiateOAuthFlow('apple'),title:'Sign in with Apple'},h('span',null,'🍎'),'Apple'),
        h('button',{className:'oauth-btn',onClick:()=>initiateOAuthFlow('facebook'),title:'Sign in with Facebook'},h('span',null,'📘'),'Facebook')
      ),
      h('div',{className:'err'},state.authError),
      h('div',{className:'toggle'},
        isLogin?'No account? ':'Already have an account? ',
        h('a',{onClick:()=>{state.authMode=isLogin?'register':'login';state.authError='';render();}},isLogin?'Register':'Sign In')
      )
    )
  );
  return card;
}

function getUserRoleLabel(){
  if(state.user?.email && state.user.email.toLowerCase().includes('admin')) return 'Administrator';
  return 'Project manager';
}

function uiIcon(sym){
  return h('span',{className:'ui-icon'},sym);
}

function buildNotifications(){
  const items = [];
  const workers = getDelegatedWorkers(state.messages);
  workers.slice(0,3).forEach(w=>items.push({title:'Approval or review from '+w, subtitle:'Delegated work completed in this chat'}));
  state.chats.slice(0,4).forEach(c=>items.push({title:'Task update: '+(c.title||'New Chat'), subtitle:'Last activity '+new Date(c.updated_at||c.created_at||Date.now()).toLocaleString()}));
  return items.slice(0,7);
}

function renderNotificationsDropdown(){
  const items = buildNotifications();
  return h('div',{className:'dropdown profile-dd',onClick:e=>e.stopPropagation()},
    h('div',{className:'pf-name'},'Notifications'),
    h('div',{className:'pf-email'},'Approvals and tasks linked to your account'),
    h('div',{className:'pf-divider'}),
    h('div',{className:'notif-list'},
      ...items.map(n=>h('div',{className:'notif-item'},h('div',{className:'nt'},n.title),h('div',{className:'ns'},n.subtitle))),
      !items.length ? h('div',{className:'notif-item'},h('div',{className:'ns'},'No pending approvals right now.')) : null
    )
  );
}

function renderWorkspaceNav(){
  const nav = h('aside',{className:'workspace-nav'},
    h('div',{className:'brand'},uiIcon('✦'),h('span',{className:'word'},'geneWeave')),
    h('div',{className:'workspace-menu'},
      h('button',{className:state.view==='chat'?'active':'',onClick:()=>{state.view='chat';render();}},uiIcon('⌂'),h('span',null,'Home')),
      h('button',{className:state.view==='connectors'?'active':'',onClick:()=>{state.view='connectors';loadConnectors();}},uiIcon('⚡'),h('span',null,'Connectors')),
      h('button',{className:state.view==='admin'?'active':'',onClick:()=>{state.view='admin';loadAdmin();}},uiIcon('⚙'),h('span',null,'Admin')),
      h('button',{className:state.view==='dashboard'?'active':'',onClick:()=>{state.view='dashboard';loadDashboard();}},uiIcon('▦'),h('span',null,'Dashboard')),
      h('a',{href:'https://github.com/gibyvarghese/weaveintel',target:'_blank',rel:'noopener'},uiIcon('ⓘ'),h('span',null,'Help & Information'))
    ),
    h('div',{className:'workspace-spacer'}),
    h('div',{className:'workspace-menu'},
      h('button',{onClick:()=>doLogout()},uiIcon('⎋'),h('span',null,'Log Out'))
    )
  );
  return nav;
}

function renderWorkspaceTopCard(){
  const userImg = document.createElement('img');
  userImg.src = getUserAvatarUrl();
  userImg.alt = state.user?.name||'User';

  const profileImg = document.createElement('img');
  profileImg.src = getUserAvatarUrl();
  profileImg.alt = state.user?.name||'User';

  const notifAnchor = h('div',{className:'dropdown-anchor'});
  const notifBtn = h('button',{className:'icon-circle',title:'Notifications',onClick:(e)=>{
    e.stopPropagation();
    state.showProfile = false;
    state.showNotifications = !state.showNotifications;
    render();
  }},'\\u{1F514}');
  if(buildNotifications().length) notifBtn.appendChild(h('span',{className:'notif-dot'}));
  notifAnchor.appendChild(notifBtn);
  if(state.showNotifications){
    const dd = renderNotificationsDropdown();
    document.body.appendChild(dd);
    requestAnimationFrame(()=>{
      const r = notifBtn.getBoundingClientRect();
      dd.style.top = (r.bottom + 8) + 'px';
      dd.style.right = (window.innerWidth - r.right) + 'px';
    });
  }

  const profileAnchor = h('div',{className:'dropdown-anchor'});
  const profileBtn = h('button',{className:'profile-avatar',title:'Profile and preferences',onClick:(e)=>{
    e.stopPropagation();
    state.showNotifications = false;
    state.showProfile = !state.showProfile;
    render();
  }},profileImg);
  profileAnchor.appendChild(profileBtn);
  if(state.showProfile){
    const dd = renderProfileDropdown();
    document.body.appendChild(dd);
    requestAnimationFrame(()=>{
      const r = profileBtn.getBoundingClientRect();
      dd.style.top = (r.bottom + 8) + 'px';
      dd.style.right = (window.innerWidth - r.right) + 'px';
    });
  }

  const searchWrap = h('div',{className:'semantic-search'});
  const input = h('input',{type:'text',placeholder:'Search chats semantically (intent, topic, context)...',value:state.chatSearchQuery||'',onInput:function(){
    state.chatSearchQuery = this.value;
    if(state._chatSearchTimer) clearTimeout(state._chatSearchTimer);
    state._chatSearchTimer = setTimeout(()=>runSemanticChatSearch(this.value),240);
  }});
  searchWrap.appendChild(input);
  if(state.chatSearchLoading || state.chatSearchResults.length){
    const rows = state.chatSearchLoading
      ? [h('div',{className:'search-item'},h('div',{className:'sub'},'Searching chats semantically...'))]
      : state.chatSearchResults.map(r=>h('div',{className:'search-item',onClick:()=>{state.chatSearchQuery='';state.chatSearchResults=[];selectChat(r.id);}},h('div',{className:'ttl'},r.title),h('div',{className:'sub'},new Date(r.updated_at||Date.now()).toLocaleString())));
    searchWrap.appendChild(h('div',{className:'search-dd'},...rows));
  }

  return h('div',{className:'workspace-top-card'},
    h('div',{className:'user-chip'},
      userImg,
      h('div',null,
        h('div',{className:'name'},state.user?.name||'User'),
        h('div',{className:'role'},getUserRoleLabel())
      )
    ),
    h('div',{className:'today-badge'},uiIcon('◷'),' ',getTodayLabel()),
    searchWrap,
    h('div',{className:'top-actions'},
      h('button',{className:'nav-btn',onClick:createChat},'+ New Chat'),
      notifAnchor,
      profileAnchor
    )
  );
}

function renderRightRail(){
  const focus = getCalendarFocusDate();
  const year = focus.getFullYear();
  const month = focus.getMonth();
  const selectedYMD = toYMD(focus);
  const counts = {};
  state.chats.forEach(c=>{
    const d = new Date(c.updated_at||c.created_at||Date.now());
    if(d.getFullYear()===year && d.getMonth()===month){
      const k = d.getDate();
      counts[k] = (counts[k]||0)+1;
    }
  });
  const focusDays = [];
  for(let i=-1;i<=3;i++){
    const d = new Date(year, month, focus.getDate()+i);
    focusDays.push(d);
  }

  const monthFirst = new Date(year, month, 1);
  const monthLast = new Date(year, month+1, 0);
  const monthCells = [];
  for(let i=0;i<monthFirst.getDay();i++) monthCells.push(h('div',{className:'md empty'},''));
  for(let day=1;day<=monthLast.getDate();day++){
    const d = new Date(year, month, day);
    const dYMD = toYMD(d);
    monthCells.push(h('div',{
      className:'md'+(counts[day]?' has':'')+(dYMD===selectedYMD?' active':''),
      onClick:()=>{ setCalendarFocusDate(d); render(); }
    },String(day)));
  }

  const actions = state.chats.slice(0,8).map(c=>h('div',{
    className:'action-item selectable'+(state.currentChatId===c.id?' active':''),
    onClick:()=>{
      if(state.currentChatId!==c.id) selectChat(c.id);
    }
  },
    h('div',{className:'at'},c.title||'New Chat'),
    h('div',{className:'as'},'Updated '+new Date(c.updated_at||c.created_at||Date.now()).toLocaleString())
  ));

  const meetingsBody = [
    h('div',{className:'meet-card peach'},
      h('div',{className:'meet-title'},'Agent Review and Approval'),
      h('div',{className:'meet-time'},focus.toLocaleDateString(undefined,{weekday:'short', month:'short', day:'2-digit'})+' • 08:00 - 08:45 (UTC)'),
      h('div',{className:'meet-row'},
        h('div',{className:'mini-avatars'},
          ...getDelegatedWorkers(state.messages).slice(0,3).map(w=>{const img=document.createElement('img');img.src=getAgentAvatarUrl(w);img.alt=w;img.title=w;return img;}),
          getDelegatedWorkers(state.messages).length>3 ? h('span',{className:'mini-more'},'+'+(getDelegatedWorkers(state.messages).length-3)) : null
        ),
        h('span',{className:'tag'},'APPROVAL')
      )
    ),
    h('div',{className:'meet-card blue'},
      h('div',{className:'meet-title'},'Chat Follow-up Actions'),
      h('div',{className:'meet-time'},focus.toLocaleDateString(undefined,{weekday:'short', month:'short', day:'2-digit'})+' • 09:00 - 09:45 (UTC)'),
      h('div',{className:'meet-row'},
        h('div',{className:'mini-avatars'},
          ...state.chats.slice(0,3).map((c,i)=>{const img=document.createElement('img');img.src=getAgentAvatarUrl((c.title||'chat')+i);img.alt='chat';return img;})
        ),
        h('span',{className:'tag'},'TASK')
      )
    )
  ];

  const eventsBody = state.chats.slice(0,2).map(c=>h('div',{className:'meet-card blue'},
    h('div',{className:'meet-title'},c.title||'Chat Event'),
    h('div',{className:'meet-time'},new Date(c.updated_at||c.created_at||Date.now()).toLocaleDateString()+' • Model activity')
  ));

  const holidayBody = [
    h('div',{className:'meet-card peach'},
      h('div',{className:'meet-title'},'No scheduled holidays'),
      h('div',{className:'meet-time'},'Use this tab for OOO and downtime events')
    )
  ];

  const tabContent = state.calendarTab==='events' ? eventsBody : state.calendarTab==='holiday' ? holidayBody : meetingsBody;

  return h('aside',{className:'right-rail'},
    h('div',{className:'side-card schedule-card'},
      h('div',{className:'schedule-head'},
        h('div',{className:'ttl'},uiIcon('◷'),' Schedule'),
        h('div',{className:'month-nav'},
          h('button',{className:'icon-btn-sm',title:'Previous month',onClick:()=>shiftCalendarMonth(-1)},'\u2039'),
          h('div',{className:'month-pill'},focus.toLocaleDateString(undefined,{month:'short', year:'numeric'})),
          h('button',{className:'icon-btn-sm',title:'Next month',onClick:()=>shiftCalendarMonth(1)},'\u203A')
        ),
        h('button',{className:'see-all',title:'Toggle full month',onClick:()=>{state.calendarShowAll=!state.calendarShowAll;render();}},
          uiIcon('▤'),
          h('span',null,state.calendarShowAll?'Hide':'See All')
        )
      ),
      !state.calendarShowAll ? h('div',{className:'day-strip'},
        ...focusDays.map((d)=>h('div',{className:'day-chip'+(toYMD(d)===selectedYMD?' active':''),title:(counts[d.getDate()]||0)+' actions',onClick:()=>{setCalendarFocusDate(d);render();}},
          h('div',{className:'dw'},d.toLocaleDateString(undefined,{weekday:'short'})),
          h('div',{className:'dn'},String(d.getDate()).padStart(2,'0'))
        ))
      ) : h('div',{className:'month-grid'},
        ...['S','M','T','W','T','F','S'].map(x=>h('div',{className:'mh'},x)),
        ...monthCells
      ),
      h('div',{className:'schedule-search'},
        h('div',{className:'search-row'},'\u{1F50D}',' Search... ',h('span',{style:'margin-left:auto'},'\u2630'))
      ),
      h('div',{className:'schedule-tabs'},
        h('div',{className:'schedule-tab'+(state.calendarTab==='meetings'?' active':''),onClick:()=>{state.calendarTab='meetings';render();}},'Meetings'),
        h('div',{className:'schedule-tab'+(state.calendarTab==='events'?' active':''),onClick:()=>{state.calendarTab='events';render();}},'Events'),
        h('div',{className:'schedule-tab'+(state.calendarTab==='holiday'?' active':''),onClick:()=>{state.calendarTab='holiday';render();}},'Holiday')
      ),
      h('div',{className:'schedule-meetings'},...tabContent)
    ),
    h('div',{className:'side-card actions-card'},
      h('h3',null,'My Actions'),
      h('div',{className:'action-list'},...actions, !actions.length ? h('div',{className:'action-item'},h('div',{className:'as'},'No actions yet')):null)
    )
  );
}

function renderHomeWorkspace(){
  const workers = getDelegatedWorkers(state.messages);
  const leadImg = document.createElement('img');
  leadImg.src = getAgentAvatarUrl('geneweave-supervisor');
  leadImg.alt = 'Lead agent';

  const settingsAnchor = h('div',{className:'dropdown-anchor'});
  const settingsBtn = h('button',{className:'hdr-icon-btn'+(state.showSettings?' active':''),title:'AI Settings',onClick:async(e)=>{
    e.stopPropagation();
    if(!state.chatSettings && state.currentChatId) await loadChatSettings(state.currentChatId);
    if(!state.chatSettings) state.chatSettings = { mode:state.defaultMode||'direct', systemPrompt:'', enabledTools:[], redactionEnabled:false, redactionPatterns:['email','phone','ssn','credit_card'], workers:[] };
    state.showSettings=!state.showSettings;
    render();
  }},'\\u2699');
  settingsAnchor.appendChild(settingsBtn);
  if(state.showSettings && state.chatSettings){
    const dd = renderSettingsDropdown();
    document.body.appendChild(dd);
    requestAnimationFrame(()=>{
      const r = settingsBtn.getBoundingClientRect();
      dd.style.top = (r.bottom + 8) + 'px';
      dd.style.right = (window.innerWidth - r.right) + 'px';
    });
  }

  const modelSel = h('select',{className:'model-sel',onChange:function(){state.selectedModel=this.value;}});
  state.models.forEach(m=>{
    const val=m.provider+':'+m.id;
    const opt=h('option',{value:val},m.provider+'/'+m.id);
    if(val===state.selectedModel) opt.selected=true;
    modelSel.appendChild(opt);
  });

  const center = h('section',{className:'center-card'},
    h('div',{className:'center-card-hdr'},
      h('div',{className:'agent-strip'},
        h('div',{className:'lead'},leadImg,h('span',null,'geneWeave Agent')),
        h('div',{className:'worker-avatars'},...workers.slice(0,6).map(w=>{const img=document.createElement('img');img.src=getAgentAvatarUrl(w);img.alt=w;img.title=w;return img;}))
      ),
      h('div',{style:'display:flex;align-items:center;gap:8px'},
        h('div',{className:'title'},(state.chats.find(c=>c.id===state.currentChatId)?.title)||'Conversation'),
        modelSel,
        settingsAnchor
      )
    ),
    renderChatView()
  );

  return h('div',{className:'workspace-home'},
    renderWorkspaceTopCard(),
    h('div',{className:'workspace-body'},center,renderRightRail())
  );
}

function renderApp(){
  const wrap = h('div',{className:'app'});
  wrap.appendChild(renderWorkspaceNav());

  const main = h('div',{className:'main'});
  if(state.view==='dashboard') main.appendChild(renderDashboard());
  else if(state.view==='admin') main.appendChild(renderAdmin());
  else if(state.view==='connectors') main.appendChild(renderConnectors());
  else if(state.view==='preferences') main.appendChild(renderPreferences());
  else main.appendChild(renderHomeWorkspace());
  wrap.appendChild(main);
  return wrap;
}

/* ── Admin ──────────────────────────────────── */

async function loadAdmin(){
  try{
    function adminPath(p){
      var path = String(p||'').replace(/^\\/+/, '');
      if(path.startsWith('api/')) path = path.slice(4);
      return '/'+path;
    }
    var keys = Object.keys(ADMIN_SCHEMA);
    var promises = keys.map(function(k){
      var s = ADMIN_SCHEMA[k];
      return api.get(adminPath(s.apiPath)).then(function(r){return r.json();}).catch(function(){var d={};d[s.listKey]=[];return d;});
    });
    var results = await Promise.all(promises);
    var data = {};
    keys.forEach(function(k,i){ var s = ADMIN_SCHEMA[k]; data[k] = results[i][s.listKey]||[]; });
    state.adminData = data;
  }catch(e){ console.error('Failed to load admin data',e); }
  render();
}

async function seedData(){
  try{
    await api.post('/admin/seed',{});
    await loadAdmin();
  }catch(e){ console.error('Seed failed',e); }
}

async function syncPricing(){
  try{
    var resp = await api.post('/admin/model-pricing/sync',{});
    if(resp && resp.ok){
      var report = await resp.json();
      var parts = [];
      Object.keys(report.providers||{}).forEach(function(p){
        var s = report.providers[p];
        parts.push(p+': '+s.discovered+' discovered, '+s.matched+' matched, '+s.upserted+' upserted'+(s.errors&&s.errors.length?' ('+s.errors.length+' errors)':''));
      });
      alert('Pricing synced!\\n\\n'+parts.join('\\n'));
      await loadAdmin();
    } else {
      var err = resp ? await resp.json() : {};
      alert('Sync failed: '+(err.error||'Unknown error'));
    }
  }catch(e){ alert('Sync error: '+e.message); }
}

async function adminSave(tab){
  var schema = ADMIN_SCHEMA[tab];
  if(!schema) return;
  function adminPath(p){
    var path = String(p||'').replace(/^\\/+/, '');
    if(path.startsWith('api/')) path = path.slice(4);
    return '/'+path;
  }
  var f = state.adminForm;
  var isEdit = !!state.adminEditing;
  var payload = {};
  schema.fields.forEach(function(fd){
    var val = f[fd.key];
    if(fd.save==='json'){ try{val=val?JSON.parse(val):null;}catch(e){val=null;} }
    else if(fd.save==='jsonStr'){ try{val=val?JSON.stringify(JSON.parse(val)):null;}catch(e){val=null;} }
    else if(fd.save==='int'){ val=val?parseInt(val):(fd['default']!=null?fd['default']:null); }
    else if(fd.save==='float'){ val=val?parseFloat(val):(fd['default']!=null?fd['default']:null); }
    else if(fd.save==='csvArr'){ val=val?val.split(',').map(function(s){return s.trim();}).filter(Boolean):[]; }
    else if(fd.save==='bool'){ val=(val===undefined||val===null)?(fd['default']!=null?fd['default']:false):val!==false&&val!=='false'; }
    else if(fd.save==='intBool'){ val=val?1:0; }
    else { val=(val!=null&&val!=='')?val:(fd['default']!=null?fd['default']:null); }
    payload[fd.key] = val;
  });
  try{
    var base = adminPath(schema.apiPath);
    var resp = isEdit ? await api.put(base+'/'+state.adminEditing,payload) : await api.post(base,payload);
    if(resp && resp.ok){
      state.adminEditing=null; state.adminForm={};
      await loadAdmin();
    } else {
      var err = resp ? await resp.json() : {};
      alert('Save failed: '+(err.error||'Unknown error'));
    }
  }catch(e){ alert('Save error: '+e.message); }
}

async function adminDelete(tab,id){
  if(!confirm('Delete this item?')) return;
  var schema = ADMIN_SCHEMA[tab];
  if(!schema) return;
  function adminPath(p){
    var path = String(p||'').replace(/^\\/+/, '');
    if(path.startsWith('api/')) path = path.slice(4);
    return '/'+path;
  }
  try{
    await api.del(adminPath(schema.apiPath)+'/'+id);
    await loadAdmin();
  }catch(e){ alert('Delete failed: '+e.message); }
}

function adminEdit(tab,item){
  state.adminEditing = item.id;
  var f = Object.assign({},item);
  var schema = ADMIN_SCHEMA[tab];
  if(schema){
    schema.fields.forEach(function(fd){
      if(fd.save==='csvArr' && f[fd.key]){
        try{f[fd.key]=JSON.parse(f[fd.key]).join(', ');}catch(e){}
      } else if((fd.textarea||fd.save==='json'||fd.save==='jsonStr') && f[fd.key]!=null && typeof f[fd.key]!=='string'){
        try{f[fd.key]=JSON.stringify(f[fd.key],null,2);}catch(e){}
      }
    });
  }
  state.adminForm = f;
  render();
}

function adminNew(){
  state.adminEditing = null;
  var f = {};
  var schema = ADMIN_SCHEMA[state.adminTab];
  if(schema){
    schema.fields.forEach(function(fd){
      if(fd['default']!=null) f[fd.key]=fd['default'];
    });
  }
  state.adminForm = f;
  render();
}

function adminCancel(){
  state.adminEditing = null;
  state.adminForm = {};
  render();
}

function inp(label,key,opts){
  var isTA = opts&&opts.textarea;
  var val = state.adminForm[key]!=null?state.adminForm[key]:'';
  var wrapper = h('div',{style:'margin-bottom:10px'});
  wrapper.appendChild(h('label',{style:'display:block;font-size:12px;font-weight:600;color:#555;margin-bottom:3px'},label));
  if(isTA){
    var ta = document.createElement('textarea');
    ta.value = typeof val==='string'?val:JSON.stringify(val,null,2);
    ta.rows = opts.rows||3;
    Object.assign(ta.style,{cssText:'width:100%;padding:7px 10px;border:1px solid #D1D5DB;border-radius:6px;font-size:13px;font-family:monospace;resize:vertical;box-sizing:border-box'});
    ta.addEventListener('input',function(){state.adminForm[key]=this.value;});
    wrapper.appendChild(ta);
  } else if(opts&&opts.type==='checkbox'){
    var cb = document.createElement('input');
    cb.type='checkbox'; cb.checked=!!state.adminForm[key];
    cb.addEventListener('change',function(){state.adminForm[key]=this.checked;render();});
    wrapper.appendChild(cb);
  } else if(opts&&opts.options){
    var sel = document.createElement('select');
    Object.assign(sel.style,{cssText:'width:100%;padding:7px 10px;border:1px solid #D1D5DB;border-radius:6px;font-size:13px;box-sizing:border-box'});
    opts.options.forEach(function(o){var op=document.createElement('option');op.value=o;op.textContent=o;if(val===o)op.selected=true;sel.appendChild(op);});
    if(state.adminForm[key]==null&&opts.options.length) state.adminForm[key]=opts.options[0];
    sel.addEventListener('change',function(){state.adminForm[key]=this.value;});
    wrapper.appendChild(sel);
  } else {
    var i = document.createElement('input');
    i.type = (opts&&opts.type)||'text';
    i.value = val;
    Object.assign(i.style,{cssText:'width:100%;padding:7px 10px;border:1px solid #D1D5DB;border-radius:6px;font-size:13px;box-sizing:border-box'});
    i.addEventListener('input',function(){state.adminForm[key]=this.value;});
    wrapper.appendChild(i);
  }
  return wrapper;
}

function renderAdminForm(tab){
  var schema = ADMIN_SCHEMA[tab];
  if(!schema) return h('div');
  var form = h('div',{style:'background:#fff;border:1px solid #E5E7EB;border-radius:10px;padding:20px;margin-bottom:16px'});
  var title = state.adminEditing?'Edit':'New';
  form.appendChild(h('h3',{style:'margin:0 0 14px;font-size:15px;color:#1E293B'},title+' '+schema.singular));
  schema.fields.forEach(function(fd){
    var opts = {};
    if(fd.textarea) opts.textarea = true;
    if(fd.rows) opts.rows = fd.rows;
    if(fd.options) opts.options = fd.options;
    if(fd.type) opts.type = fd.type;
    form.appendChild(inp(fd.label,fd.key,opts));
  });
  var btns = h('div',{style:'display:flex;gap:8px;margin-top:14px'});
  btns.appendChild(h('button',{className:'nav-btn active',onClick:function(){adminSave(tab);}},state.adminEditing?'Update':'Create'));
  btns.appendChild(h('button',{className:'nav-btn',onClick:adminCancel},'Cancel'));
  form.appendChild(btns);
  return form;
}

function renderAdminTable(tab){
  var items = state.adminData[tab]||[];
  var table = h('div',{style:'background:#fff;border:1px solid #E5E7EB;border-radius:10px;overflow:hidden'});

  if(items.length===0){
    table.appendChild(h('div',{style:'padding:30px;text-align:center;color:#94A3B8;font-size:14px'},
      'No items yet. Click "+ New" to create one, or "Seed Defaults" to load sample data.'
    ));
    return table;
  }

  var schema = ADMIN_SCHEMA[tab];
  var isReadOnly = schema && schema.readOnly;
  var cols = getAdminCols(tab);
  var gridCols = cols.map(function(c){return c.w||'1fr';}).join(' ')+(isReadOnly?'':' 100px');
  var thead = h('div',{style:'display:grid;grid-template-columns:'+gridCols+';padding:10px 16px;background:#F8FAFC;border-bottom:1px solid #E5E7EB;font-size:11px;font-weight:700;color:#64748B;text-transform:uppercase;letter-spacing:0.5px'});
  cols.forEach(function(c){thead.appendChild(h('span',null,c.label));});
  if(!isReadOnly) thead.appendChild(h('span',null,'Actions'));
  table.appendChild(thead);

  items.forEach(function(item){
    var row = h('div',{style:'display:grid;grid-template-columns:'+gridCols+';padding:10px 16px;border-bottom:1px solid #F1F5F9;font-size:13px;align-items:center;transition:background 0.15s',onMouseEnter:function(){this.style.background='#F8FAFC'},onMouseLeave:function(){this.style.background='transparent'}});
    cols.forEach(function(c){
      var v = item[c.key];
      var cellStyle = 'color:#334155;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      if(c.key==='enabled'||c.key==='is_default'||c.key==='requires_approval'||c.key==='require_human_review'||c.key==='auto_update'||c.key==='auto_link'||c.key==='handoff_enabled'||c.key==='require_versioning'||c.key==='network_access'){ v=v?'\\u2713':'\\u2717'; cellStyle=item[c.key]?'color:#16A34A':'color:#DC2626'; }
      else if(c.key==='status'){
        var st=String(v||'');
        var colors={completed:'#16A34A',paused:'#D97706',failed:'#DC2626',running:'#2563EB',pending:'#64748B'};
        cellStyle='color:'+(colors[st]||'#334155')+';font-weight:600';
      }
      else if(c.key==='overall_decision'){
        var d=String(v||'');
        var dcolors={allow:'#16A34A',deny:'#DC2626',warn:'#D97706'};
        cellStyle='color:'+(dcolors[d]||'#334155')+';font-weight:600';
      }
      else if(typeof v==='string'&&v.length>40) v=v.slice(0,40)+'...';
      else if(v===null||v===undefined) v='\\u2014';
      row.appendChild(h('span',{style:cellStyle},String(v)));
    });
    if(!isReadOnly){
      var acts = h('div',{style:'display:flex;gap:6px'});
      acts.appendChild(h('button',{style:'padding:3px 10px;font-size:12px;border:1px solid #D1D5DB;border-radius:5px;background:#fff;cursor:pointer;color:#2563EB',onClick:function(){adminEdit(tab,item);}},'Edit'));
      acts.appendChild(h('button',{style:'padding:3px 10px;font-size:12px;border:1px solid #FCA5A5;border-radius:5px;background:#FEF2F2;cursor:pointer;color:#DC2626',onClick:function(){adminDelete(tab,item.id);}},'Del'));
      row.appendChild(acts);
    }
    table.appendChild(row);
  });
  return table;
}

function getAdminCols(tab){
  var schema = ADMIN_SCHEMA[tab];
  if(!schema) return [];
  return schema.cols.map(function(key){
    var label = key.replace(/_/g,' ').replace(/\bid\b/gi,'ID').replace(/\bms\b/g,'(ms)').replace(/\burl\b/gi,'URL').replace(/\b\w/g,function(c){return c.toUpperCase();});
    var w = key==='name'?'1.5fr':(key==='enabled'||key==='auto_link'||key==='auto_update')?'0.5fr':'1fr';
    return {key:key,label:label,w:w};
  });
}

/* ── About panel ─────────────────────────────────────────── */
function renderAboutPanel(){
  var wrap = h('div',{style:'max-width:560px'});

  /* Logo / title */
  wrap.appendChild(h('div',{style:'display:flex;align-items:center;gap:14px;margin-bottom:24px'},
    h('div',{style:'width:56px;height:56px;border-radius:14px;background:linear-gradient(135deg,#6366F1,#8B5CF6);display:flex;align-items:center;justify-content:center;font-size:28px;color:#fff'},'\uD83E\uDDF6'),
    h('div',{},
      h('div',{style:'font-size:22px;font-weight:800;color:#1E293B'},'geneWeave'),
      h('div',{style:'font-size:13px;color:#64748B;margin-top:2px'},'Built on weaveIntel')
    )
  ));

  /* Version card */
  var card = h('div',{style:'background:var(--bg2);border:1px solid #E5E7EB;border-radius:12px;padding:20px;margin-bottom:20px'});
  card.appendChild(h('div',{style:'font-size:11px;font-weight:700;color:var(--fg3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px'},'Installed Version'));

  if(!state._aboutInfo){
    card.appendChild(h('div',{style:'color:var(--fg3);font-size:13px'},'Loading version info\u2026'));
    /* Fetch version info */
    fetch('/api/admin/version',{credentials:'include'}).then(function(r){return r.json();}).then(function(d){
      state._aboutInfo=d; render();
    }).catch(function(){
      state._aboutInfo={currentVersion:'unknown',codename:'',error:true}; render();
    });
  } else {
    var info = state._aboutInfo;
    card.appendChild(h('div',{style:'display:flex;align-items:baseline;gap:10px;margin-bottom:6px'},
      h('span',{style:'font-size:28px;font-weight:800;color:#1E293B'},'v'+info.currentVersion),
      h('span',{style:'font-size:15px;font-weight:600;color:#6366F1'},'\u201C'+info.codename+'\u201D')
    ));

    if(info.latestVersion && !info.updateAvailable){
      card.appendChild(h('div',{style:'display:flex;align-items:center;gap:6px;margin-top:10px;color:#16A34A;font-size:13px;font-weight:600'},
        '\u2705 You are on the latest version'
      ));
    }

    if(info.updateAvailable){
      var updateBox = h('div',{style:'margin-top:14px;padding:14px;background:#FEF3C7;border:1px solid #F59E0B;border-radius:8px'});
      updateBox.appendChild(h('div',{style:'font-weight:700;color:#92400E;font-size:14px;margin-bottom:4px'},
        '\u26A0\uFE0F Update Available'));
      updateBox.appendChild(h('div',{style:'font-size:13px;color:#78350F'},
        'Version v'+info.latestVersion+' \u201C'+info.latestCodename+'\u201D is available.'
      ));

      var upgradeBtn = h('button',{
        className:'nav-btn active',
        style:'margin-top:10px;font-size:13px',
        onClick:function(){
          if(!confirm('This will pull the latest code from GitHub, install dependencies, and rebuild. Proceed?')) return;
          state._upgradeStatus='running'; render();
          fetch('/api/admin/upgrade',{method:'POST',credentials:'include'}).then(function(r){return r.json();}).then(function(d){
            state._upgradeStatus=d.ok?'done':'error';
            state._upgradeMsg=d.message||d.error||''; render();
          }).catch(function(e){
            state._upgradeStatus='error';
            state._upgradeMsg=e.message||'Network error'; render();
          });
        }
      },'\u2B06\uFE0F Upgrade to v'+info.latestVersion);

      if(state._upgradeStatus==='running'){
        updateBox.appendChild(h('div',{style:'margin-top:10px;font-size:13px;color:#78350F'},'\u23F3 Upgrading\u2026 this may take a few minutes.'));
      } else if(state._upgradeStatus==='done'){
        updateBox.appendChild(h('div',{style:'margin-top:10px;font-size:13px;color:#16A34A;font-weight:600'},'\u2705 '+state._upgradeMsg));
      } else if(state._upgradeStatus==='error'){
        updateBox.appendChild(h('div',{style:'margin-top:10px;font-size:13px;color:#DC2626;font-weight:600'},'\u274C '+state._upgradeMsg));
      } else {
        updateBox.appendChild(upgradeBtn);
      }
      card.appendChild(updateBox);
    }

    if(info.error){
      card.appendChild(h('div',{style:'color:#DC2626;font-size:13px;margin-top:8px'},'Could not fetch version information.'));
    }
  }
  wrap.appendChild(card);

  /* Links */
  var links = h('div',{style:'display:flex;gap:12px;flex-wrap:wrap'});
  links.appendChild(h('a',{href:'https://github.com/gibyvarghese/weaveintel',target:'_blank',
    style:'font-size:13px;color:var(--accent);text-decoration:none;font-weight:600'},'\uD83D\uDD17 GitHub Repository'));
  links.appendChild(h('a',{href:'https://github.com/gibyvarghese/weaveintel/releases',target:'_blank',
    style:'font-size:13px;color:var(--accent);text-decoration:none;font-weight:600'},'\uD83D\uDCE6 Releases'));
  links.appendChild(h('a',{href:'https://github.com/gibyvarghese/weaveintel/blob/main/VERSIONING.md',target:'_blank',
    style:'font-size:13px;color:var(--accent);text-decoration:none;font-weight:600'},'\uD83E\uDDF5 Versioning Guide'));
  wrap.appendChild(links);

  /* Refresh button */
  wrap.appendChild(h('div',{style:'margin-top:20px'},
    h('button',{className:'nav-btn',style:'font-size:12px',onClick:function(){
      state._aboutInfo=null; state._upgradeStatus=null; state._upgradeMsg=null; render();
    }},'\uD83D\uDD04 Refresh')
  ));

  return wrap;
}

/* ── Connectors ─────────────────────────────── */

const CONNECTOR_DEFS = [
  { id:'jira',        label:'Jira',        category:'enterprise', icon:'🔧', desc:'Project tracking & issue management', color:'#0052CC', authMethod:'oauth' },
  { id:'servicenow',  label:'ServiceNow',  category:'enterprise', icon:'🏢', desc:'IT service management & workflows', color:'#62D84E', authMethod:'oauth', needsDomain:true },
  { id:'facebook',    label:'Facebook',    category:'social',     icon:'📘', desc:'Pages, posts & audience engagement', color:'#1877F2', authMethod:'oauth' },
  { id:'instagram',   label:'Instagram',   category:'social',     icon:'📷', desc:'Business content & media publishing', color:'#E4405F', authMethod:'oauth' },
  { id:'canva',       label:'Canva',       category:'enterprise', icon:'🎨', desc:'Design assets & creative workflows', color:'#00C4CC', authMethod:'oauth' },
];

async function loadConnectors(){
  state.view='connectors';
  state.connectorsLoading=true;
  render();
  try{
    var r = await api.get('/api/connectors');
    var data = await r.json();
    state.connectors = { enterprise: data.enterprise||[], social: data.social||[] };
  }catch(e){
    state.connectors = { enterprise:[], social:[] };
  }
  state.connectorsLoading=false;
  render();
  loadCredentials();
  loadSSOProviders();
  loadOAuthAccounts();
}

function getConnectorStatus(def){
  var list = def.category==='social' ? state.connectors.social : state.connectors.enterprise;
  var key = def.category==='social' ? 'platform' : 'connector_type';
  return list.find(function(c){ return c[key]===def.id; });
}

function connectorOAuthConnect(def){
  var existing = getConnectorStatus(def);
  var connectorId = existing ? existing.id : null;

  // If no record exists yet, create one first
  if(!connectorId){
    var table = def.category==='social' ? 'social-accounts' : 'enterprise-connectors';
    var body = def.category==='social'
      ? { name:def.label, platform:def.id, description:def.desc }
      : { name:def.label, connector_type:def.id, description:def.desc, auth_type:'oauth2' };
    api.post('/api/admin/'+table, body).then(function(r){ return r.json(); }).then(function(data){
      var item = data['social-account'] || data['enterprise-connector'];
      if(item) connectorId = item.id;
      startOAuthFlow(def, connectorId);
    }).catch(function(){ alert('Failed to create connector record'); });
  } else {
    startOAuthFlow(def, connectorId);
  }
}

function startOAuthFlow(def, connectorId){
  var qs = 'connector_id=' + encodeURIComponent(connectorId||'');
  api.get('/api/connectors/'+def.id+'/authorize?'+qs).then(function(r){ return r.json(); }).then(function(data){
    if(!data.url){ alert('Could not get authorization URL'); return; }
    var popup = window.open(data.url, 'oauth-'+def.id, 'width=600,height=700,scrollbars=yes');
    // Listen for postMessage from the popup callback page
    function onMsg(e){
      if(e.data && (e.data.type==='oauth-success' || e.data.type==='oauth-error')){
        window.removeEventListener('message', onMsg);
        if(e.data.type==='oauth-success'){
          loadConnectors();
        } else {
          alert('OAuth error: '+(e.data.error||'Unknown error'));
          loadConnectors();
        }
      }
    }
    window.addEventListener('message', onMsg);
  }).catch(function(err){
    alert('Failed to start OAuth: '+err.message);
  });
}

function connectorDisconnect(def){
  var existing = getConnectorStatus(def);
  if(!existing) return;
  var table = def.category==='social' ? 'social' : 'enterprise';
  api.post('/api/connectors/'+existing.id+'/disconnect', { table:table }).then(function(){
    loadConnectors();
  }).catch(function(err){
    alert('Failed to disconnect: '+err.message);
  });
}

function connectorTest(def){
  var existing = getConnectorStatus(def);
  if(!existing) return;
  var table = def.category==='social' ? 'social' : 'enterprise';
  api.post('/api/connectors/'+existing.id+'/test', { table:table }).then(function(r){ return r.json(); }).then(function(data){
    if(data.ok) alert('\\u2705 '+data.message);
    else alert('\\u274C '+data.message);
  }).catch(function(err){
    alert('Test failed: '+err.message);
  });
}

function renderConnectorCard(def){
  var existing = getConnectorStatus(def);
  var connected = existing && existing.status==='connected';
  var statusText = connected ? 'Connected' : 'Not connected';
  var statusColor = connected ? '#16A34A' : '#94A3B8';
  var statusDot = connected ? '#16A34A' : '#CBD5E1';

  var card = h('div',{style:'background:var(--bg2);border:1px solid '+(connected?'#BBF7D0':'#E5E7EB')+';border-radius:12px;padding:20px;display:flex;flex-direction:column;gap:12px;transition:all 0.2s;position:relative'});

  /* Status indicator */
  card.appendChild(h('div',{style:'position:absolute;top:12px;right:12px;display:flex;align-items:center;gap:6px'},
    h('span',{style:'width:8px;height:8px;border-radius:50%;background:'+statusDot+';display:inline-block'}),
    h('span',{style:'font-size:11px;color:'+statusColor+';font-weight:500'},statusText)
  ));

  /* Icon and name */
  card.appendChild(h('div',{style:'display:flex;align-items:center;gap:12px'},
    h('div',{style:'width:44px;height:44px;border-radius:10px;background:'+def.color+'18;display:flex;align-items:center;justify-content:center;font-size:22px'},def.icon),
    h('div',null,
      h('div',{style:'font-weight:700;font-size:15px;color:var(--fg)'},def.label),
      h('div',{style:'font-size:12px;color:var(--fg3);margin-top:2px'},def.desc)
    )
  ));

  /* Token info if connected */
  if(connected && existing.token_expires_at){
    var expires = new Date(existing.token_expires_at);
    var now = new Date();
    var expiresIn = Math.round((expires - now) / 60000);
    var expiryText = expiresIn > 0 ? 'Token expires in '+expiresIn+' min' : 'Token expired';
    var expiryColor = expiresIn > 60 ? '#64748B' : expiresIn > 0 ? '#D97706' : '#DC2626';
    card.appendChild(h('div',{style:'font-size:11px;color:'+expiryColor+';padding:4px 8px;background:var(--bg3);border-radius:6px;width:fit-content'},expiryText));
  }

  /* Actions */
  var actions = h('div',{style:'display:flex;gap:8px;margin-top:auto;padding-top:4px'});
  if(connected){
    actions.appendChild(h('button',{className:'nav-btn',style:'font-size:12px;flex:1',onClick:function(){ connectorTest(def); }},'\\u{1F50D} Test'));
    actions.appendChild(h('button',{className:'nav-btn',style:'font-size:12px;color:#DC2626;flex:1',onClick:function(){ connectorDisconnect(def); }},'\\u26D4 Disconnect'));
  } else {
    actions.appendChild(h('button',{className:'nav-btn active',style:'font-size:12px;flex:1;background:'+def.color+';border-color:'+def.color,onClick:function(){ connectorOAuthConnect(def); }},'\\u{1F517} Connect'));
  }
  card.appendChild(actions);

  return card;
}

/* ── Website Credentials ────────────────────── */

async function loadCredentials(){
  try{
    var r = await api.get('/credentials');
    var data = await r.json();
    state.credentials = data.credentials || [];
  }catch(e){ state.credentials = []; }
  render();
}

async function saveCredential(){
  var f = state.credentialForm;
  if(!f) return;
  if(!f.siteName||!f.siteUrlPattern||!f.authMethod){
    alert('Site Name, URL Pattern, and Auth Method are required.');
    return;
  }
  var config = {method:f.authMethod};
  if(f.authMethod==='form_fill'){
    config.username = f.username||'';
    config.password = f.password||'';
    if(f.usernameSelector||f.passwordSelector||f.submitSelector){
      config.selectors = {};
      if(f.usernameSelector) config.selectors.username = f.usernameSelector;
      if(f.passwordSelector) config.selectors.password = f.passwordSelector;
      if(f.submitSelector) config.selectors.submit = f.submitSelector;
    }
  } else if(f.authMethod==='header'){
    config.headerValue = f.headerValue||'';
  } else if(f.authMethod==='cookie'){
    try{ config.cookies = JSON.parse(f.cookiesJson||'[]'); }catch(e){ alert('Invalid cookies JSON'); return; }
  }

  try{
    if(state.credentialEditing){
      await api.put('/credentials/'+state.credentialEditing, {
        siteName:f.siteName,
        siteUrlPattern:f.siteUrlPattern,
        authMethod:f.authMethod,
        config:config,
      });
    } else {
      await api.post('/credentials', {
        siteName:f.siteName,
        siteUrlPattern:f.siteUrlPattern,
        authMethod:f.authMethod,
        config:config,
      });
    }
    state.credentialForm = null;
    state.credentialEditing = null;
    await loadCredentials();
  }catch(e){ alert('Failed to save: '+(e.message||e)); }
}

async function deleteCredential(id){
  if(!confirm('Delete this credential? This cannot be undone.')) return;
  try{
    await api.del('/credentials/'+id);  // api helper prepends /api
    await loadCredentials();
  }catch(e){ alert('Failed to delete: '+(e.message||e)); }
}

/* ── External Password Manager Import ────────── */

async function loadPasswordProviders(){
  try{
    var r = await api.get('/password-providers');
    state.importProviders = await r.json();
  }catch(e){ state.importProviders = []; }
  render();
}

async function runPasswordImport(){
  if(!state.importProvider) return;
  state.importLoading = true;
  state.importResult = null;
  render();
  try{
    var body = { provider: state.importProvider, config: state.importConfig || {}, search:'' };
    var r = await api.post('/password-providers/import', body);
    var data = await r.json();
    if(!r.ok){ state.importResult = { error: data.error || 'Import failed' }; }
    else { state.importResult = data; }
    await loadCredentials();
  }catch(e){
    state.importResult = { error: e.message || String(e) };
  }
  state.importLoading = false;
  render();
}

function renderImportPanel(){
  var panel = h('div',{style:'background:linear-gradient(135deg,#EEF2FF,#F0FDFA);border:1px solid #C7D2FE;border-radius:12px;padding:20px;margin-bottom:20px'});
  panel.appendChild(h('div',{style:'display:flex;justify-content:space-between;align-items:center;margin-bottom:16px'},
    h('div',{style:'font-weight:700;font-size:15px;color:#1E293B'},'\u{1F4E5} Import from Password Manager'),
    h('button',{style:'background:none;border:none;cursor:pointer;font-size:18px;color:#64748B',onClick:function(){
      state.importShow=false; state.importProvider=null; state.importConfig={}; state.importResult=null;
      render();
    }},'\u2715')
  ));

  // Provider selection cards
  if(!state.importProviders){
    panel.appendChild(h('div',{style:'color:#64748B;font-size:13px'},'Loading providers…'));
    loadPasswordProviders();
    return panel;
  }

  if(!state.importProvider){
    var grid = h('div',{style:'display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px'});
    var icons = {'1password':'\u{1F511}','bitwarden':'\u{1F6E1}\uFE0F','apple_keychain':'\u{1F34E}','chrome':'\u{1F310}','csv':'\u{1F4C4}'};
    var labels = {'1password':'1Password','bitwarden':'Bitwarden','apple_keychain':'Apple Keychain','chrome':'Chrome Passwords','csv':'CSV Import'};
    (state.importProviders||[]).forEach(function(p){
      var isAvail = p.available;
      var card = h('div',{style:'background:'+(isAvail?'#fff':'#F8FAFC')+';border:1px solid '+(isAvail?'#D1D5DB':'#E5E7EB')+';border-radius:10px;padding:14px;text-align:center;cursor:'+(isAvail?'pointer':'not-allowed')+';opacity:'+(isAvail?'1':'0.6')+';transition:all .15s',
        onClick:isAvail?function(){ state.importProvider=p.provider; state.importConfig={}; render(); }:null},
        h('div',{style:'font-size:28px;margin-bottom:6px'},icons[p.provider]||'\u{1F511}'),
        h('div',{style:'font-size:13px;font-weight:600;color:#1E293B'},labels[p.provider]||p.provider),
        h('div',{style:'font-size:10px;color:'+(isAvail?'#16A34A':'#DC2626')+';margin-top:4px'},isAvail?(p.version||'Available'):'Not available')
      );
      if(isAvail){
        card.addEventListener('mouseenter',function(){this.style.borderColor='#6366F1';this.style.boxShadow='0 0 0 2px rgba(99,102,241,.15)';});
        card.addEventListener('mouseleave',function(){this.style.borderColor='#D1D5DB';this.style.boxShadow='none';});
      }
      if(!isAvail && p.reason){
        card.setAttribute('title',p.reason);
      }
      grid.appendChild(card);
    });
    panel.appendChild(grid);
    return panel;
  }

  // Provider-specific config form
  var selected = state.importProvider;
  panel.appendChild(h('div',{style:'display:flex;align-items:center;gap:8px;margin-bottom:14px'},
    h('button',{style:'background:none;border:none;cursor:pointer;font-size:14px;color:#6366F1',onClick:function(){ state.importProvider=null; state.importResult=null; render(); }},'\u2190 Back'),
    h('span',{style:'font-weight:600;font-size:14px;color:#1E293B'},(labels||{})[selected]||selected)
  ));

  var configArea = h('div',{style:'display:grid;gap:10px;margin-bottom:14px'});

  if(selected==='1password'){
    configArea.appendChild(renderImportField('Service Account Token','serviceAccountToken','Paste your OP_SERVICE_ACCOUNT_TOKEN',true));
  } else if(selected==='bitwarden'){
    configArea.appendChild(renderImportField('Master Password','password','Your Bitwarden master password',true));
    configArea.appendChild(renderImportField('Client ID (optional)','clientId','BW_CLIENTID'));
    configArea.appendChild(renderImportField('Client Secret (optional)','clientSecret','BW_CLIENTSECRET'));
  } else if(selected==='csv'){
    var ta = h('textarea',{style:'width:100%;height:120px;padding:10px;border:1px solid #D1D5DB;border-radius:8px;font-size:12px;font-family:monospace;box-sizing:border-box;resize:vertical',
      placeholder:'Paste your CSV export here…\\n\\nSupported formats: Chrome, Firefox, Bitwarden, 1Password, LastPass CSV exports.',
      onInput:function(){ state.importConfig.csvContent = this.value; }
    });
    if(state.importConfig.csvContent) ta.value = state.importConfig.csvContent;
    configArea.appendChild(h('div',null,
      h('label',{style:'display:block;font-size:12px;font-weight:600;color:#64748B;margin-bottom:4px'},'CSV Content'),
      ta
    ));
  }
  // apple_keychain and chrome need no config

  panel.appendChild(configArea);

  // Import button + result
  var btnRow = h('div',{style:'display:flex;align-items:center;gap:12px'});
  var importBtn = h('button',{className:'nav-btn active',style:'font-size:13px;padding:8px 20px',disabled:state.importLoading,
    onClick:function(){ runPasswordImport(); }
  },state.importLoading?'Importing…':'\u{1F4E5} Import Credentials');
  btnRow.appendChild(importBtn);

  if(state.importResult){
    if(state.importResult.error){
      btnRow.appendChild(h('span',{style:'font-size:12px;color:#DC2626'},'\u274C '+state.importResult.error));
    } else {
      btnRow.appendChild(h('span',{style:'font-size:12px;color:#16A34A'},'\u2705 Imported '+state.importResult.imported+' of '+state.importResult.total+' credentials'));
    }
  }
  panel.appendChild(btnRow);

  return panel;
}

function renderImportField(label,key,placeholder,isSecret){
  return h('div',null,
    h('label',{style:'display:block;font-size:12px;font-weight:600;color:#64748B;margin-bottom:4px'},label),
    h('input',{type:isSecret?'password':'text',value:state.importConfig[key]||'',placeholder:placeholder||'',
      style:'width:100%;padding:8px 10px;border:1px solid #D1D5DB;border-radius:6px;font-size:13px;box-sizing:border-box',
      onInput:function(){ state.importConfig[key]=this.value; }
    })
  );
}

/* ── SSO Pass-Through (Identity Provider Sessions) ────────── */

async function loadSSOProviders(){
  try{
    var r = await api.get('/sso/providers');
    var data = await r.json();
    state.ssoProviders = data.providers || [];
  }catch(e){ state.ssoProviders = []; }
  render();
}

async function unlinkSSOProvider(provider){
  if(!confirm('Unlink '+provider+' from SSO? Future OAuth logins to sites using '+provider+' will require manual authentication.')) return;
  try{
    await api.del('/sso/providers/'+provider);
    await loadSSOProviders();
  }catch(e){ alert('Failed to unlink: '+(e.message||e)); }
}

function openGuidedSSOConnect(target){
  var urls = {
    github_google: 'https://github.com/login',
    google: 'https://accounts.google.com/',
    github: 'https://github.com/login',
    microsoft: 'https://login.microsoftonline.com/',
    apple: 'https://appleid.apple.com/',
    facebook: 'https://www.facebook.com/login/',
  };
  var url = urls[target] || urls['github_google'];
  window.open(url, '_blank', 'noopener');
}

function copyGuidedSSOPrompt(provider){
  var email = state.user?.email || 'your-email@example.com';
  var lines = [
    'Use browser_open for https://github.com/login',
    'Select Sign in with Google and complete login manually (including CAPTCHA/2FA if prompted).',
    'Run browser_capture_sso with provider='+provider+' and email='+email,
    'Then run browser_sso_login with provider='+provider,
  ];
  var txt = lines.join('\\n');
  var done = function(){ alert('Guided SSO prompt copied. Paste it in chat and run step-by-step.'); };
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(txt).then(done).catch(function(){ window.prompt('Copy this guided prompt:', txt); });
  } else {
    window.prompt('Copy this guided prompt:', txt);
  }
}

function renderSSOProviders(){
  var section = h('div',{style:'background:#F0F9FF;border:1px solid #BAE6FD;border-radius:12px;padding:16px;margin-bottom:20px'});
  section.appendChild(h('div',{style:'font-weight:700;font-size:14px;margin-bottom:12px;color:#0369A1'},'\u{1F517} Linked SSO Providers'));

  var guide = h('div',{style:'background:#FFFFFF;border:1px solid #BFDBFE;border-radius:10px;padding:12px;margin-bottom:12px'},
    h('div',{style:'font-size:12px;font-weight:700;color:#1E40AF;margin-bottom:6px'},'\u{1F6A9} Guided Connect (recommended)'),
    h('div',{style:'font-size:12px;color:#475569;line-height:1.5;margin-bottom:8px'},'For GitHub with Google social login: open GitHub login, complete Google sign-in manually once, then capture SSO for pass-through.'),
    h('div',{style:'display:flex;gap:8px;flex-wrap:wrap'},
      h('button',{className:'nav-btn active',style:'font-size:11px',onClick:function(){ openGuidedSSOConnect('github_google'); }},'\u{1F517} Open GitHub Login'),
      h('button',{className:'nav-btn',style:'font-size:11px',onClick:function(){ copyGuidedSSOPrompt('google'); }},'\u{1F4CB} Copy Guided Prompt')
    )
  );
  section.appendChild(guide);
  
  if(!state.ssoProviders){
    section.appendChild(h('div', { style: 'font-size:12px;color:#64748B' }, 'Loading…'));
    loadSSOProviders();
    return section;
  }

  if(state.ssoProviders.length === 0){
    section.appendChild(h('div',{style:'font-size:12px;color:#64748B'},'No linked identity providers yet. Use browser_capture_sso or click "Link Provider" to add one.'));
    return section;
  }

  var grid = h('div',{style:'display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px'});
  var icons = {google:'\u{1F518}',github:'\u{26A1}',microsoft:'\u{1F309}',apple:'\u{1F34E}',facebook:'\u{1F4C4}'};
  state.ssoProviders.forEach(function(p){
    var card = h('div',{style:'background:#fff;border:1px solid #BAE6FD;border-radius:10px;padding:12px;display:flex;align-items:center;justify-content:space-between'});
    card.appendChild(h('div',{style:'display:flex;align-items:center;gap:8px'},
      h('span',{style:'font-size:24px'},icons[p.identity_provider]||'\u{1F4D1}'),
      h('div',null,
        h('div',{style:'font-weight:600;font-size:13px;color:#1E293B;text-transform:capitalize'},p.identity_provider),
        h('div', {style: 'font-size:11px;color:#64748B'}, p.email ? ('Signed in as ' + p.email) : 'Captured ' + (p.linked_at ? new Date(p.linked_at).toLocaleDateString() : 'recently'))
      )
    ));
    card.appendChild(h('button',{style:'background:#EF4444;color:white;border:none;border-radius:6px;padding:6px 10px;cursor:pointer;font-size:11px;font-weight:600',
      onClick:function(){ unlinkSSOProvider(p.identity_provider); }
    },'\u274C Unlink'));
    grid.appendChild(card);
  });
  section.appendChild(grid);
  return section;
}

async function loadOAuthAccounts(){
  try{
    var r = await api.get('/oauth/accounts');
    var data = await r.json();
    state.oauthAccounts = data.accounts || [];
  }catch(e){ state.oauthAccounts = []; }
  render();
}

async function unlinkOAuthAccount(provider){
  if(!confirm('Unlink '+provider+' account? You won\\\'t be able to sign in with '+provider+' in the future.')) return;
  try{
    const r = await api.post('/oauth/accounts/'+provider+'/unlink', {});
    if(r.ok) await loadOAuthAccounts();
    else alert('Failed to unlink account');
  }catch(e){ alert('Failed to unlink: '+(e.message||e)); }
}

function renderOAuthAccounts(){
  var section = h('div',{style:'background:#FEF3C7;border:1px solid #FCD34D;border-radius:12px;padding:16px;margin-bottom:20px'});
  section.appendChild(h('div',{style:'font-weight:700;font-size:14px;margin-bottom:12px;color:#92400E'},'\u{1F512} Linked OAuth Accounts'));
  
  if(!state.oauthAccounts){
    section.appendChild(h('div', { style: 'font-size:12px;color:#64748B' }, 'Loading…'));
    loadOAuthAccounts();
    return section;
  }

  if(state.oauthAccounts.length === 0){
    section.appendChild(h('div',{style:'font-size:12px;color:#64748B'},'No linked OAuth accounts. You can link social accounts for quick sign-in.'));
    return section;
  }

  var grid = h('div',{style:'display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px'});
  var icons = {google:'\u{1F518}',github:'\u{26A1}',microsoft:'\u{1F309}',apple:'\u{1F34E}',facebook:'\u{1F4C4}'};
  state.oauthAccounts.forEach(function(acc){
    var card = h('div',{style:'background:#fff;border:1px solid #FCD34D;border-radius:10px;padding:12px;display:flex;align-items:center;justify-content:space-between'});
    card.appendChild(h('div',{style:'display:flex;align-items:center;gap:8px;flex:1;min-width:0'},
      acc.picture_url ? h('img',{src:acc.picture_url,style:'width:32px;height:32px;border-radius:50%;object-fit:cover'}) : h('span',{style:'font-size:24px'},icons[acc.provider]||'\u{1F4D1}'),
      h('div',{style:'min-width:0'},
        h('div',{style:'font-weight:600;font-size:13px;color:#1E293B;text-transform:capitalize;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'},acc.name||acc.email),
        h('div', {style: 'font-size:11px;color:#64748B;text-transform:capitalize;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'}, acc.provider + ' • ' + (acc.last_used_at ? 'Last used ' + new Date(acc.last_used_at).toLocaleDateString() : 'Never used'))
      )
    ));
    card.appendChild(h('button',{style:'background:#EF4444;color:white;border:none;border-radius:6px;padding:6px 10px;cursor:pointer;font-size:11px;font-weight:600;flex-shrink:0',
      onClick:function(){ unlinkOAuthAccount(acc.provider); }
    },'\u274C Unlink'));
    grid.appendChild(card);
  });
  section.appendChild(grid);
  return section;
}

function renderCredentialForm(){
  var f = state.credentialForm || {};
  var isEdit = !!state.credentialEditing;

  var form = h('div',{style:'background:var(--bg2);border:1px solid #E5E7EB;border-radius:12px;padding:20px;margin-bottom:20px'});
  form.appendChild(h('div',{style:'font-weight:700;font-size:15px;margin-bottom:16px;color:#1E293B'}, isEdit ? '\\u270F\\uFE0F Edit Credential' : '\\u2795 New Website Credential'));

  var grid = h('div',{style:'display:grid;grid-template-columns:1fr 1fr;gap:12px'});

  // Site Name
  grid.appendChild(h('div',null,
    h('label',{style:'display:block;font-size:12px;font-weight:600;color:#64748B;margin-bottom:4px'},'Site Name'),
    h('input',{type:'text',value:f.siteName||'',placeholder:'e.g. GitHub',style:'width:100%;padding:8px 10px;border:1px solid #D1D5DB;border-radius:6px;font-size:13px;box-sizing:border-box',onInput:function(){ f.siteName=this.value; }})
  ));

  // URL Pattern
  grid.appendChild(h('div',null,
    h('label',{style:'display:block;font-size:12px;font-weight:600;color:#64748B;margin-bottom:4px'},'URL Pattern'),
    h('input',{type:'text',value:f.siteUrlPattern||'',placeholder:'e.g. *.github.com/*',style:'width:100%;padding:8px 10px;border:1px solid #D1D5DB;border-radius:6px;font-size:13px;box-sizing:border-box',onInput:function(){ f.siteUrlPattern=this.value; }})
  ));

  // Auth Method
  var sel = h('select',{style:'width:100%;padding:8px 10px;border:1px solid #D1D5DB;border-radius:6px;font-size:13px;box-sizing:border-box;background:white',onChange:function(){ f.authMethod=this.value; state.credentialForm=f; render(); }});
  [['form_fill','Form Fill (Username/Password)'],['cookie','Cookie Injection'],['header','Authorization Header']].forEach(function(opt){
    var o = h('option',{value:opt[0]},opt[1]);
    if(f.authMethod===opt[0]) o.selected = true;
    sel.appendChild(o);
  });
  grid.appendChild(h('div',{style:'grid-column:1/-1'},
    h('label',{style:'display:block;font-size:12px;font-weight:600;color:#64748B;margin-bottom:4px'},'Auth Method'),
    sel
  ));

  // Method-specific fields
  if(f.authMethod==='form_fill'){
    grid.appendChild(h('div',null,
      h('label',{style:'display:block;font-size:12px;font-weight:600;color:#64748B;margin-bottom:4px'},'Username'),
      h('input',{type:'text',value:f.username||'',placeholder:'username or email',style:'width:100%;padding:8px 10px;border:1px solid #D1D5DB;border-radius:6px;font-size:13px;box-sizing:border-box',onInput:function(){ f.username=this.value; },autocomplete:'off'})
    ));
    grid.appendChild(h('div',null,
      h('label',{style:'display:block;font-size:12px;font-weight:600;color:#64748B;margin-bottom:4px'},'Password'),
      h('input',{type:'password',value:f.password||'',placeholder:'\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022',style:'width:100%;padding:8px 10px;border:1px solid #D1D5DB;border-radius:6px;font-size:13px;box-sizing:border-box',onInput:function(){ f.password=this.value; },autocomplete:'new-password'})
    ));
    grid.appendChild(h('div',{style:'grid-column:1/-1'},
      h('label',{style:'display:block;font-size:12px;font-weight:600;color:#64748B;margin-bottom:4px'},'CSS Selectors (optional)'),
      h('div',{style:'display:flex;gap:8px'},
        h('input',{type:'text',value:f.usernameSelector||'',placeholder:'Username selector',style:'flex:1;padding:8px 10px;border:1px solid #D1D5DB;border-radius:6px;font-size:12px;box-sizing:border-box',onInput:function(){ f.usernameSelector=this.value; }}),
        h('input',{type:'text',value:f.passwordSelector||'',placeholder:'Password selector',style:'flex:1;padding:8px 10px;border:1px solid #D1D5DB;border-radius:6px;font-size:12px;box-sizing:border-box',onInput:function(){ f.passwordSelector=this.value; }}),
        h('input',{type:'text',value:f.submitSelector||'',placeholder:'Submit selector',style:'flex:1;padding:8px 10px;border:1px solid #D1D5DB;border-radius:6px;font-size:12px;box-sizing:border-box',onInput:function(){ f.submitSelector=this.value; }})
      )
    ));
  } else if(f.authMethod==='header'){
    grid.appendChild(h('div',{style:'grid-column:1/-1'},
      h('label',{style:'display:block;font-size:12px;font-weight:600;color:#64748B;margin-bottom:4px'},'Authorization Header Value'),
      h('input',{type:'password',value:f.headerValue||'',placeholder:'Bearer eyJ...',style:'width:100%;padding:8px 10px;border:1px solid #D1D5DB;border-radius:6px;font-size:13px;box-sizing:border-box',onInput:function(){ f.headerValue=this.value; },autocomplete:'off'})
    ));
  } else if(f.authMethod==='cookie'){
    grid.appendChild(h('div',{style:'grid-column:1/-1'},
      h('label',{style:'display:block;font-size:12px;font-weight:600;color:#64748B;margin-bottom:4px'},'Cookies JSON'),
      h('textarea',{value:f.cookiesJson||'[{"name":"session","value":"...","domain":".example.com"}]',placeholder:'[{"name":"session","value":"...","domain":".example.com"}]',style:'width:100%;padding:8px 10px;border:1px solid #D1D5DB;border-radius:6px;font-size:12px;font-family:monospace;height:80px;resize:vertical;box-sizing:border-box',onInput:function(){ f.cookiesJson=this.value; }})
    ));
  }

  form.appendChild(grid);

  // Buttons
  var btns = h('div',{style:'display:flex;gap:8px;margin-top:16px;justify-content:flex-end'});
  btns.appendChild(h('button',{className:'nav-btn',style:'font-size:12px',onClick:function(){ state.credentialForm=null; state.credentialEditing=null; render(); }},'Cancel'));
  btns.appendChild(h('button',{className:'nav-btn active',style:'font-size:12px',onClick:saveCredential}, isEdit ? 'Update' : 'Save'));
  form.appendChild(btns);

  return form;
}

function renderCredentialCard(cred){
  var methodIcons = {form_fill:'\\u{1F4DD}', cookie:'\\u{1F36A}', header:'\\u{1F511}', oauth_flow:'\\u{1F310}'};
  var methodLabels = {form_fill:'Form Fill', cookie:'Cookie', header:'Header Auth', oauth_flow:'OAuth Flow'};
  var icon = methodIcons[cred.authMethod] || '\\u{1F512}';
  var label = methodLabels[cred.authMethod] || cred.authMethod;
  var active = cred.status==='active';

  var card = h('div',{style:'background:var(--bg2);border:1px solid '+(active?'#BBF7D0':'#FED7AA')+';border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:10px;position:relative'});

  card.appendChild(h('div',{style:'position:absolute;top:10px;right:10px;display:flex;align-items:center;gap:5px'},
    h('span',{style:'width:7px;height:7px;border-radius:50%;background:'+(active?'#16A34A':'#F59E0B')+';display:inline-block'}),
    h('span',{style:'font-size:10px;color:'+(active?'#16A34A':'#F59E0B')+';font-weight:500'},active?'Active':'Inactive')
  ));

  card.appendChild(h('div',{style:'display:flex;align-items:center;gap:10px'},
    h('div',{style:'width:38px;height:38px;border-radius:8px;background:#E0F2FE;display:flex;align-items:center;justify-content:center;font-size:18px'},icon),
    h('div',null,
      h('div',{style:'font-weight:700;font-size:14px;color:var(--fg)'},cred.siteName),
      h('div',{style:'font-size:11px;color:var(--fg3);margin-top:1px;font-family:monospace'},cred.siteUrlPattern)
    )
  ));

  card.appendChild(h('div',{style:'display:flex;gap:8px;flex-wrap:wrap'},
    h('span',{style:'font-size:10px;padding:3px 8px;background:#F1F5F9;border-radius:4px;color:#475569;font-weight:500'},label),
    cred.lastUsedAt ? h('span',{style:'font-size:10px;padding:3px 8px;background:#F0FDF4;border-radius:4px;color:#166534'},'Last used: '+new Date(cred.lastUsedAt).toLocaleDateString()) : null
  ));

  var actions = h('div',{style:'display:flex;gap:6px;margin-top:auto;padding-top:4px'});
  actions.appendChild(h('button',{className:'nav-btn',style:'font-size:11px;flex:1',onClick:function(){
    state.credentialEditing = cred.id;
    state.credentialForm = {
      siteName:cred.siteName, siteUrlPattern:cred.siteUrlPattern,
      authMethod:cred.authMethod, username:'', password:''
    };
    render();
  }},'\\u270F\\uFE0F Edit'));
  actions.appendChild(h('button',{className:'nav-btn',style:'font-size:11px;color:#DC2626;flex:1',onClick:function(){ deleteCredential(cred.id); }},'\\u{1F5D1} Delete'));
  card.appendChild(actions);

  return card;
}

function renderCredentialsSection(){
  var section = h('div',{style:'margin-bottom:32px'});

  section.appendChild(h('div',{style:'display:flex;justify-content:space-between;align-items:center;margin-bottom:16px'},
    h('div',null,
      h('h3',{style:'margin:0 0 4px;font-size:14px;font-weight:700;color:#1E293B'},'\\u{1F512} Website Credentials'),
      h('p',{style:'margin:0;font-size:12px;color:#94A3B8'},'Stored credentials for browser auto-login. Encrypted at rest — passwords are never exposed.')
    ),
    h('div',{style:'display:flex;gap:8px'},
      h('button',{className:'nav-btn',style:'font-size:12px',onClick:function(){
        state.importShow=!state.importShow; state.importProvider=null; state.importConfig={}; state.importResult=null;
        render();
      }},'\u{1F4E5} Import'),
      h('button',{className:'nav-btn active',style:'font-size:12px',onClick:function(){
        state.credentialForm = { siteName:'', siteUrlPattern:'', authMethod:'form_fill', username:'', password:'' };
        state.credentialEditing = null;
        render();
      }},'+ Add Credential')
    )
  ));

  if(state.importShow){
    section.appendChild(renderImportPanel());
  }

  if(state.credentialForm){
    section.appendChild(renderCredentialForm());
  }

  if(state.credentials.length){
    var grid = h('div',{style:'display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px'});
    state.credentials.forEach(function(c){ grid.appendChild(renderCredentialCard(c)); });
    section.appendChild(grid);
  } else if(!state.credentialForm){
    section.appendChild(h('div',{style:'text-align:center;padding:32px;color:#94A3B8;background:var(--bg2);border-radius:12px;border:1px dashed #E5E7EB'},
      h('div',{style:'font-size:24px;margin-bottom:8px'},'\\u{1F512}'),
      h('div',{style:'font-size:13px'},'No website credentials stored yet.'),
      h('div',{style:'font-size:11px;margin-top:4px'},'Add credentials so the browser agent can auto-login to sites.')
    ));
  }

  // SSO Linked Providers section
  section.appendChild(renderSSOProviders());

  // OAuth Linked Accounts section
  section.appendChild(renderOAuthAccounts());

  return section;
}

function renderConnectors(){
  var view = h('div',{style:'display:flex;flex-direction:column;flex:1;overflow:hidden'});

  /* Header */
  var hdr = h('div',{style:'display:flex;justify-content:space-between;align-items:center;padding:16px 24px;border-bottom:1px solid #E5E7EB;background:var(--bg2);flex-shrink:0'});
  hdr.appendChild(h('div',null,
    h('h2',{style:'margin:0;font-size:20px;font-weight:700;color:#1E293B'},'\\u26A1 Connectors'),
    h('p',{style:'margin:4px 0 0;font-size:13px;color:#64748B'},'Connect your external services with OAuth for seamless integration')
  ));
  hdr.appendChild(h('button',{className:'nav-btn',style:'font-size:12px',onClick:loadConnectors},'\\uD83D\\uDD04 Refresh'));
  view.appendChild(hdr);

  /* Content */
  var content = h('div',{style:'flex:1;overflow-y:auto;padding:24px'});

  if(state.connectorsLoading){
    content.appendChild(h('div',{style:'text-align:center;padding:48px;color:#64748B'},'Loading connectors…'));
    view.appendChild(content);
    return view;
  }

  /* Enterprise section */
  var enterpriseDefs = CONNECTOR_DEFS.filter(function(d){ return d.category==='enterprise'; });
  content.appendChild(h('div',{style:'margin-bottom:24px'},
    h('h3',{style:'margin:0 0 4px;font-size:14px;font-weight:700;color:#1E293B'},'\\u{1F3E2} Enterprise'),
    h('p',{style:'margin:0 0 16px;font-size:12px;color:#94A3B8'},'Business tools and service management platforms')
  ));
  var grid1 = h('div',{style:'display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;margin-bottom:32px'});
  enterpriseDefs.forEach(function(d){ grid1.appendChild(renderConnectorCard(d)); });
  content.appendChild(grid1);

  /* Social section */
  var socialDefs = CONNECTOR_DEFS.filter(function(d){ return d.category==='social'; });
  content.appendChild(h('div',{style:'margin-bottom:24px'},
    h('h3',{style:'margin:0 0 4px;font-size:14px;font-weight:700;color:#1E293B'},'\\u{1F4F1} Social Media'),
    h('p',{style:'margin:0 0 16px;font-size:12px;color:#94A3B8'},'Social platforms for content and audience management')
  ));
  var grid2 = h('div',{style:'display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;margin-bottom:32px'});
  socialDefs.forEach(function(d){ grid2.appendChild(renderConnectorCard(d)); });
  content.appendChild(grid2);

  /* Website Credentials section */
  content.appendChild(renderCredentialsSection());

  /* Environment vars info */
  content.appendChild(h('div',{style:'background:#FFFBEB;border:1px solid #FDE68A;border-radius:8px;padding:16px;margin-top:8px'},
    h('div',{style:'font-weight:600;font-size:13px;color:#92400E;margin-bottom:6px'},'\\u{1F511} OAuth Configuration'),
    h('div',{style:'font-size:12px;color:#78350F;line-height:1.6'},
      'Set these environment variables before connecting:',
      h('div',{style:'margin-top:8px;font-family:monospace;font-size:11px;background:#FEF3C7;padding:8px 12px;border-radius:6px;white-space:pre-wrap'},
        'JIRA_CLIENT_ID / JIRA_CLIENT_SECRET\\nSERVICENOW_CLIENT_ID / SERVICENOW_CLIENT_SECRET\\nFACEBOOK_CLIENT_ID / FACEBOOK_CLIENT_SECRET\\nINSTAGRAM_CLIENT_ID / INSTAGRAM_CLIENT_SECRET\\nCANVA_CLIENT_ID / CANVA_CLIENT_SECRET'
      )
    )
  ));

  view.appendChild(content);
  return view;
}

function renderAdmin(){
  var view = h('div',{style:'display:flex;flex-direction:column;flex:1;overflow:hidden'});

  /* Header */
  var hdr = h('div',{style:'display:flex;justify-content:space-between;align-items:center;padding:16px 24px;border-bottom:1px solid #E5E7EB;background:var(--bg2);flex-shrink:0'});
  hdr.appendChild(h('h2',{style:'margin:0;font-size:20px;font-weight:700;color:#1E293B'},'Administration'));
  var hdrBtns = h('div',{style:'display:flex;gap:8px'});
  hdrBtns.appendChild(h('button',{className:'nav-btn',style:'font-size:12px',onClick:seedData},'Seed Defaults'));
  hdr.appendChild(hdrBtns);
  view.appendChild(hdr);

  /* Layout: sidebar + content */
  var layout = h('div',{style:'display:flex;flex:1;overflow:hidden'});

  /* Sidebar navigation */
  var nav = h('div',{style:'width:200px;border-right:1px solid #E5E7EB;background:var(--bg2);overflow-y:auto;flex-shrink:0;padding:8px 0'});
  ADMIN_GROUPS.forEach(function(group){
    nav.appendChild(h('div',{style:'padding:14px 16px 4px;font-size:10px;font-weight:700;color:var(--fg3);text-transform:uppercase;letter-spacing:.5px'},group.icon+' '+group.label));
    group.tabs.forEach(function(t){
      var active = state.adminTab===t.key;
      nav.appendChild(h('button',{
        style:'display:block;width:100%;text-align:left;padding:7px 16px 7px 24px;font-size:13px;border:none;font-family:inherit;font-weight:'+(active?'600':'400')+';color:'+(active?'var(--accent)':'var(--fg2)')+';background:'+(active?'var(--accent-dim)':'transparent')+';cursor:pointer;transition:all 0.15s',
        onClick:function(){state.adminTab=t.key;state.adminEditing=null;state.adminForm={};render();}
      },t.label));
    });
  });
  layout.appendChild(nav);

  /* Content area */
  var content = h('div',{style:'flex:1;overflow-y:auto;padding:24px;max-width:900px'});
  var tab = state.adminTab;
  var schema = ADMIN_SCHEMA[tab];
  var isReadOnlyTab = schema && schema.readOnly;

  /* ── About panel (custom) ── */
  if(tab==='about'){
    content.appendChild(renderAboutPanel());
    layout.appendChild(content);
    view.appendChild(layout);
    return view;
  }

  /* Form (if editing or creating) */
  if(!isReadOnlyTab && (state.adminEditing!==null||Object.keys(state.adminForm).length>0)){
    content.appendChild(renderAdminForm(tab));
  }

  /* Action bar */
  var actions = h('div',{style:'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px'});
  var count = (state.adminData[tab]||[]).length;
  actions.appendChild(h('span',{style:'font-size:13px;color:#64748B'},count+' item'+(count!==1?'s':'')));
  if(!isReadOnlyTab && !state.adminEditing && Object.keys(state.adminForm).length===0){
    var actionBtns = h('div',{style:'display:flex;gap:8px'});
    if(tab==='model-pricing'){
      actionBtns.appendChild(h('button',{className:'nav-btn',style:'font-size:12px',onClick:syncPricing},'\uD83D\uDD04 Sync Pricing'));
    }
    actionBtns.appendChild(h('button',{className:'nav-btn active',style:'font-size:12px',onClick:adminNew},'+ New'));
    actions.appendChild(actionBtns);
  }
  content.appendChild(actions);

  /* Table */
  content.appendChild(renderAdminTable(tab));

  layout.appendChild(content);
  view.appendChild(layout);
  return view;
}



function renderChatView(){
  const view = h('div',{className:'chat-view'});

  /* ── Handoff notification banner ─── */
  if(state.handoffRequest){
    var ho = state.handoffRequest;
    var banner = h('div',{style:'background:#FEF3C7;border:1px solid #FCD34D;border-radius:10px;margin:12px 16px 0;padding:14px 18px;display:flex;flex-direction:column;gap:10px;flex-shrink:0'});
    banner.appendChild(h('div',{style:'display:flex;align-items:center;gap:8px'},
      h('span',{style:'font-size:20px'},'\\u{1F6A8}'),
      h('div',{style:'flex:1'},
        h('div',{style:'font-weight:700;font-size:14px;color:#92400E'},'Browser Handoff Requested'),
        h('div',{style:'font-size:12px;color:#78350F;margin-top:2px'},ho.reason||'The agent needs you to complete an action in the browser.')
      )
    ));
    if(ho.url){
      banner.appendChild(h('div',{style:'font-size:11px;color:#78350F;font-family:monospace;background:#FDE68A;padding:4px 8px;border-radius:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'},'\\u{1F517} '+ho.url));
    }
    if(ho.screenshot){
      var img = h('img',{src:'data:image/png;base64,'+ho.screenshot,style:'max-width:100%;max-height:200px;border-radius:6px;border:1px solid #FCD34D'});
      banner.appendChild(img);
    }
    var hoBtns = h('div',{style:'display:flex;gap:8px'});
    hoBtns.appendChild(h('button',{className:'nav-btn active',style:'font-size:12px;background:#059669;border-color:#059669;color:white',onClick:function(){
      var msg = 'Resume the browser session' + (ho.sessionId ? ' (session: '+ho.sessionId+')' : '') + (ho.taskId ? ' (task: '+ho.taskId+')' : '');
      state.handoffRequest = null;
      render();
      sendMessage(msg);
    }},'\\u2705 I\\'m Done — Resume Agent'));
    hoBtns.appendChild(h('button',{className:'nav-btn',style:'font-size:12px',onClick:function(){
      state.handoffRequest = null;
      render();
    }},'Dismiss'));
    banner.appendChild(hoBtns);
    view.appendChild(banner);
  }

  /* ── Messages ─── */
  const msgContainer = h('div',{className:'messages'});
  view.appendChild(msgContainer);

  /* ── Input bar ─── */
  const ta = h('textarea',{placeholder:'Type a message...',rows:'1'});
  if(state.pendingDraft){
    ta.value = state.pendingDraft;
    state.pendingDraft = '';
    requestAnimationFrame(()=>{ ta.style.height='auto'; ta.style.height=Math.min(ta.scrollHeight,160)+'px'; ta.focus(); });
  }
  ta.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage(ta.value);ta.value='';ta.style.height='auto';}});
  ta.addEventListener('input',()=>{ta.style.height='auto';ta.style.height=Math.min(ta.scrollHeight,160)+'px';});

  const fileInput = h('input',{type:'file',multiple:true,accept:'image/*,audio/*,text/*,application/json,.md,.csv',style:'display:none'});
  fileInput.addEventListener('change',async()=>{
    var files = Array.from(fileInput.files || []);
    await queueFiles(files);
    fileInput.value = '';
  });

  const attachmentStrip = state.pendingAttachments.length
    ? h('div',{className:'attach-strip'},
        ...state.pendingAttachments.map(function(att, idx){
          return h('div',{className:'attach-chip'},
            h('span',{className:'name'},(att.name||'attachment')+' ('+(att.size||0)+'b)'),
            h('button',{className:'remove',onClick:()=>removePendingAttachment(idx)},'×')
          );
        })
      )
    : null;

  const tools = h('div',{className:'input-tools'},
    h('button',{className:'tool-btn',title:'Attach files',onClick:()=>fileInput.click()},'📎'),
    h('button',{className:'tool-btn'+(state.audioRecording?' active':''),title:state.audioRecording?'Stop recording':'Record audio',onClick:()=>toggleAudioRecording()},state.audioRecording?'⏹':'🎤')
  );

  const composer = h('div',{className:'composer-wrap'},
    attachmentStrip,
    ta
  );

  view.appendChild(h('div',{className:'input-bar'},
    fileInput,
    tools,
    composer,
    h('button',{className:'send-btn',onClick:()=>{sendMessage(ta.value);ta.value='';ta.style.height='auto';},disabled:state.streaming?'true':null},'Send')
  ));

  setTimeout(()=>{renderMessages();scrollMessages();},0);
  return view;
}

function renderSettingsDropdown(){
  const s = state.chatSettings;
  if(!s) return h('div');
  const modes = [
    {id:'direct',icon:'\\u{1F4AC}',title:'Direct',desc:'Simple model chat — no tools or agents'},
    {id:'agent',icon:'\\u{1F916}',title:'Agent (ReAct)',desc:'Autonomous tool-calling agent with reasoning loop'},
    {id:'supervisor',icon:'\\u{1F9E0}',title:'Supervisor',desc:'Multi-agent hierarchy — delegates to specialist workers'},
  ];
  const modeCards = modes.map(m=>h('div',{className:'mode-card'+(s.mode===m.id?' selected':''),onClick:()=>{s.mode=m.id;saveChatSettings();render();}},
    h('div',{className:'mc-icon'},m.icon),
    h('div',{className:'mc-body'},
      h('div',{className:'mc-title'},m.title),
      h('div',{className:'mc-desc'},m.desc)
    )
  ));

  const sections = [
    h('div',{className:'settings-section'},
      h('div',{className:'sec-label'},'AI Mode'),
      h('div',{className:'mode-cards'},...modeCards)
    )
  ];

  /* Tools are now auto-selected based on the mode via tool policies (no manual selection needed) */

  /* Redaction toggle */
  const redactToggle = h('div',{className:'toggle-switch'+(s.redactionEnabled?' on':''),onClick:()=>{
    s.redactionEnabled=!s.redactionEnabled; saveChatSettings(); render();
  }});
  sections.push(h('div',{className:'settings-section'},
    h('div',{className:'sec-row'},
      h('div',{className:'sec-label',style:'margin-bottom:0;flex:1'},'PII Redaction'),
      redactToggle
    )
  ));

  /* System prompt */
  const sysInput = h('input',{type:'text',value:s.systemPrompt||'',placeholder:'Custom system prompt...',style:'width:100%;padding:8px 10px;border-radius:var(--radius);border:1px solid var(--bg4);background:var(--bg3);color:var(--fg);font-size:13px',onChange:function(){s.systemPrompt=this.value;saveChatSettings();}});
  sections.push(h('div',{className:'settings-section'},
    h('div',{className:'sec-label'},'System Prompt'),
    sysInput
  ));

  const tzInput = h('input',{type:'text',value:s.timezone||'',placeholder:'User timezone (e.g. Pacific/Auckland)...',style:'width:100%;padding:8px 10px;border-radius:var(--radius);border:1px solid var(--bg4);background:var(--bg3);color:var(--fg);font-size:13px',onChange:function(){s.timezone=this.value;saveChatSettings();}});
  sections.push(h('div',{className:'settings-section'},
    h('div',{className:'sec-label'},'User Timezone'),
    tzInput
  ));

  const dd = h('div',{className:'dropdown settings-dd',onClick:e=>e.stopPropagation()},
    h('h3',null,h('span',{className:'ai-icon'},'\\u2699'),' Agentic AI Settings'),
    ...sections
  );
  return dd;
}

function renderThemePreferenceControls(){
  return h('div',{style:'display:flex;gap:10px;flex-wrap:wrap'},
    h('button',{
      className:'nav-btn'+(state.theme==='light'?' active':''),
      style:'font-size:12px;padding:8px 14px',
      onClick:function(){ setTheme('light'); }
    },'Light Theme'),
    h('button',{
      className:'nav-btn'+(state.theme==='dark'?' active':''),
      style:'font-size:12px;padding:8px 14px',
      onClick:function(){ setTheme('dark'); }
    },'Dark Theme')
  );
}

function renderPreferences(){
  const view = h('div',{className:'dash-view'},h('h2',null,'Preferences'));
  const appearance = h('div',{className:'chart-box',style:'max-width:760px'},
    h('h3',null,'Appearance'),
    h('p',{style:'font-size:13px;line-height:1.6;color:var(--fg2);margin-bottom:16px'},'Choose how geneWeave looks for your account. Your selection is saved automatically and reused the next time you sign in.'),
    renderThemePreferenceControls(),
    h('div',{style:'display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-top:18px'},
      h('div',{className:'card',style:'padding:18px'},
        h('div',{className:'label'},'Current Theme'),
        h('div',{style:'font-size:20px;font-weight:700;color:var(--fg);margin-bottom:8px'},state.theme==='dark'?'Dark':'Light'),
        h('div',{style:'font-size:12px;color:var(--fg2);line-height:1.6'},state.theme==='dark'?'Dark mode uses deeper surfaces with mint accents for lower glare.':'Light mode uses the sage palette as the default brand experience.')
      ),
      h('div',{className:'card',style:'padding:18px'},
        h('div',{className:'label'},'Account'),
        h('div',{style:'font-size:15px;font-weight:700;color:var(--fg);margin-bottom:4px'},state.user?.name||'User'),
        h('div',{style:'font-size:12px;color:var(--fg2);line-height:1.6'},state.user?.email||'')
      )
    )
  );
  view.appendChild(appearance);
  return view;
}

function renderProfileDropdown(){
  const u = state.user||{};
  const pfAvatar = document.createElement('img');
  pfAvatar.src = getUserAvatarUrl();
  pfAvatar.alt = u.name||'User';
  pfAvatar.style.cssText = 'width:48px;height:48px;border-radius:50%;object-fit:cover;margin-bottom:10px';
  const dd = h('div',{className:'dropdown profile-dd',onClick:e=>e.stopPropagation()},
    pfAvatar,
    h('div',{className:'pf-name'},u.name||'User'),
    h('div',{className:'pf-email'},u.email||''),
    h('div',{className:'pf-divider'}),
    h('button',{className:'pf-btn',onClick:()=>{state.view='preferences';state.showProfile=false;render();}},'\u{1F3A8} Preferences'),
    h('button',{className:'pf-btn',onClick:()=>{state.view='dashboard';state.showProfile=false;loadDashboard();}},'\\u{1F4CA} Dashboard'),
    h('button',{className:'pf-btn',onClick:()=>{state.view='admin';state.showProfile=false;loadAdmin();}},'\\u{2699}\\u{FE0F} Admin'),
    h('div',{className:'pf-divider'}),
    h('button',{className:'pf-btn danger',onClick:()=>{state.showProfile=false;doLogout();}},'\\u{1F6AA} Sign Out')
  );
  return dd;
}

function renderDashboard(){
  const d = state.dashboard;
  const view = h('div',{className:'dash-view'},h('h2',null,'Dashboard'));
  if(!d||!d.overview){
    view.appendChild(h('div',{className:'empty-chat'},'Loading dashboard…'));
    return view;
  }
  const s = d.overview.summary||{};
  view.appendChild(h('div',{className:'cards'},
    h('div',{className:'card'},h('div',{className:'label'},'Total Tokens'),h('div',{className:'value tokens'},(s.total_tokens||0).toLocaleString())),
    h('div',{className:'card'},h('div',{className:'label'},'Total Cost'),h('div',{className:'value cost'},'$'+(s.total_cost||0).toFixed(4))),
    h('div',{className:'card'},h('div',{className:'label'},'Avg Latency'),h('div',{className:'value latency'},(s.avg_latency_ms||0)+'ms')),
    h('div',{className:'card'},h('div',{className:'label'},'Messages'),h('div',{className:'value'},(s.total_messages||0).toString())),
    h('div',{className:'card'},h('div',{className:'label'},'Chats'),h('div',{className:'value'},(s.total_chats||0).toString())),
    h('div',{className:'card'},h('div',{className:'label'},'Requests'),h('div',{className:'value'},(d.performance.totalRequests||0).toString())),
  ));

  view.appendChild(h('div',{className:'charts'},
    h('div',{className:'chart-box'},h('h3',null,'Cost by Model'),h('canvas',{id:'costModelChart'})),
    h('div',{className:'chart-box'},h('h3',null,'Cost Over Time'),h('canvas',{id:'costDayChart'})),
    h('div',{className:'chart-box'},h('h3',null,'Latency by Model'),h('canvas',{id:'latencyChart'})),
  ));

  /* Eval table */
  const evals = d.evals.evals||[];
  if(evals.length){
    const rows = evals.map(ev=>
      h('tr',null,
        h('td',null,ev.eval_name),
        h('td',null,(ev.score*100).toFixed(1)+'%'),
        h('td',null,ev.passed+'/'+ev.total),
        h('td',null,ev.created_at?.slice(0,16)||'')
      )
    );
    view.appendChild(h('div',{className:'table-wrap'},
      h('h3',null,'Evaluation Results'),
      h('table',{className:'eval-table'},
        h('thead',null,h('tr',null,h('th',null,'Name'),h('th',null,'Score'),h('th',null,'Passed'),h('th',null,'Date'))),
        h('tbody',null,...rows)
      )
    ));
  }

  /* ── Agent Activity Accordion ─── */
  const activityData = d.agentActivity||[];
  if(activityData.length){
    const actSection = h('div',{className:'agent-activity'},
      h('h3',null,'\\u{1F916} Agent Activity')
    );

    activityData.forEach(a=>{
      const item = h('div',{className:'acc-item'});
      const modeIcon = a.mode==='supervisor'?'\\u{1F9E0}':a.mode==='agent'?'\\u{1F916}':'\\u{1F4AC}';
      const modeClass = 'acc-badge mode-'+a.mode;
      const timeStr = a.createdAt ? new Date(a.createdAt).toLocaleString() : '';
      const costStr = a.cost!=null ? '$'+a.cost.toFixed(6) : '';
      const tokStr = a.tokensUsed ? a.tokensUsed.toLocaleString()+' tok' : '';

      /* Header row */
      const hdr = h('div',{className:'acc-hdr',onClick:()=>{item.classList.toggle('open');}},
        h('span',{className:'acc-chevron'},'\\u25B6'),
        h('span',{className:'acc-icon'},modeIcon),
        h('div',{className:'acc-title'},
          h('div',{className:'acc-name'},a.agentName||a.mode+' call'),
          h('div',{className:'acc-sub'},
            h('span',null,a.provider+'/'+a.model),
            h('span',null,tokStr),
            h('span',null,costStr),
            h('span',null,(a.latencyMs||0)+'ms'),
            h('span',null,timeStr)
          )
        ),
        h('div',{className:'acc-badges'},
          h('span',{className:modeClass},a.mode),
          a.redactionEnabled ? h('span',{className:'acc-badge',style:'background:rgba(239,68,68,.15);color:var(--danger)'},'REDACT') : null,
          a.eval ? h('span',{className:'acc-badge',style:'background:'+(a.eval.passed>=a.eval.total?'rgba(34,197,94,.15);color:var(--success)':'rgba(239,68,68,.15);color:var(--danger)')},a.eval.score!=null?(a.eval.score*100).toFixed(0)+'%':'eval') : null
        )
      );
      item.appendChild(hdr);

      /* Body */
      const body = h('div',{className:'acc-body'});

      /* ─ Config section ─ */
      const configSec = h('div',{className:'acc-section'},h('div',{className:'asl'},'Configuration'));
      const configKv = h('div',{className:'acc-kv'});
      configKv.appendChild(h('span',{className:'ak'},'Agent'));
      configKv.appendChild(h('span',{className:'av mono'},a.agentName||'—'));
      configKv.appendChild(h('span',{className:'ak'},'Mode'));
      configKv.appendChild(h('span',{className:'av'},a.mode));
      configKv.appendChild(h('span',{className:'ak'},'Model'));
      configKv.appendChild(h('span',{className:'av mono'},a.provider+'/'+a.model));
      configKv.appendChild(h('span',{className:'ak'},'Chat'));
      configKv.appendChild(h('span',{className:'av'},a.chatTitle||a.chatId));
      configKv.appendChild(h('span',{className:'ak'},'Tokens'));
      configKv.appendChild(h('span',{className:'av'},tokStr||'—'));
      configKv.appendChild(h('span',{className:'ak'},'Cost'));
      configKv.appendChild(h('span',{className:'av'},costStr||'—'));
      configKv.appendChild(h('span',{className:'ak'},'Latency'));
      configKv.appendChild(h('span',{className:'av'},(a.latencyMs||0)+'ms'));
      if(a.traceId){
        configKv.appendChild(h('span',{className:'ak'},'Trace ID'));
        configKv.appendChild(h('span',{className:'av mono'},a.traceId));
      }
      configSec.appendChild(configKv);
      body.appendChild(configSec);

      /* ─ System Prompt section ─ */
      if(a.systemPrompt){
        body.appendChild(h('div',{className:'acc-section'},
          h('div',{className:'asl'},'System Prompt'),
          h('div',{className:'acc-prompt'},a.systemPrompt)
        ));
      }

      /* ─ Enabled Tools section ─ */
      if(a.enabledTools && a.enabledTools.length){
        const toolTags = a.enabledTools.map(t=>h('span',{className:'acc-tool-tag'},t));
        body.appendChild(h('div',{className:'acc-section'},
          h('div',{className:'asl'},'Enabled Tools'),
          h('div',{className:'acc-tools'},...toolTags)
        ));
      }

      /* ─ Steps accordion ─ */
      if(a.steps && a.steps.length){
        const stepsSec = h('div',{className:'acc-section'},h('div',{className:'asl'},'Execution Steps ('+a.steps.length+')'));
        const stepsWrap = h('div',{className:'step-acc'});
        a.steps.forEach((s,i)=>{
          const sItem = h('div',{className:'step-acc-item'});
          const sIcon = s.type==='thinking'?'\\u{1F4AD}':s.toolCall?'\\u{1F527}':s.delegation?'\\u{1F91D}':'\\u25CF';
          const sTitle = s.toolCall ? 'Tool: '+s.toolCall.name : s.delegation ? 'Delegate: '+(s.delegation.worker||s.delegation.name||'') : s.type||'step';
          const sDur = s.durationMs!=null ? s.durationMs+'ms' : '';

          sItem.appendChild(h('div',{className:'step-acc-hdr',onClick:()=>{sItem.classList.toggle('open');}},
            h('span',{className:'step-acc-chevron'},'\\u25B6'),
            h('span',{className:'step-acc-icon'},sIcon),
            h('span',{className:'step-acc-title'},'Step '+(i+1)+': '+sTitle),
            h('span',{className:'step-acc-dur'},sDur)
          ));

          const sBody = h('div',{className:'step-acc-body'});

          /* Step type info */
          if(s.toolCall){
            sBody.appendChild(h('div',{className:'step-label'},'Tool Name'));
            sBody.appendChild(h('pre',null,s.toolCall.name));
            if(s.toolCall.arguments!=null){
              sBody.appendChild(h('div',{className:'step-label'},'Input'));
              sBody.appendChild(h('pre',null,typeof s.toolCall.arguments==='string'?s.toolCall.arguments:JSON.stringify(s.toolCall.arguments,null,2)));
            }
            if(s.toolCall.result!=null){
              sBody.appendChild(h('div',{className:'step-label'},'Output'));
              sBody.appendChild(h('pre',null,typeof s.toolCall.result==='string'?s.toolCall.result:JSON.stringify(s.toolCall.result,null,2)));
            }
          } else if(s.delegation){
            sBody.appendChild(h('div',{className:'step-label'},'Worker'));
            sBody.appendChild(h('pre',null,JSON.stringify(s.delegation,null,2)));
          }
          if(s.content){
            sBody.appendChild(h('div',{className:'step-label'},'Content'));
            sBody.appendChild(h('pre',null,s.content));
          }

          sItem.appendChild(sBody);
          stepsWrap.appendChild(sItem);
        });
        stepsSec.appendChild(stepsWrap);
        body.appendChild(stepsSec);
      }

      /* ─ Eval section ─ */
      if(a.eval){
        const ev = a.eval;
        const evalKv = h('div',{className:'acc-kv'});
        evalKv.appendChild(h('span',{className:'ak'},'Score'));
        evalKv.appendChild(h('span',{className:'av'},(ev.score!=null?(ev.score*100).toFixed(1)+'%':'—')));
        evalKv.appendChild(h('span',{className:'ak'},'Passed'));
        evalKv.appendChild(h('span',{className:'av'},ev.passed+'/'+ev.total));
        body.appendChild(h('div',{className:'acc-section'},
          h('div',{className:'asl'},'Evaluation'),
          evalKv
        ));
      }

      /* ─ Response preview ─ */
      if(a.content){
        const preview = a.content.length>300 ? a.content.slice(0,300)+'…' : a.content;
        body.appendChild(h('div',{className:'acc-section'},
          h('div',{className:'asl'},'Response Preview'),
          h('div',{className:'acc-prompt'},preview)
        ));
      }

      item.appendChild(body);
      actSection.appendChild(item);
    });

    view.appendChild(actSection);
  }

  /* Trace viewer */
  const traceData = d.traces||[];
  if(traceData.length){
    const roots = traceData.filter(t=>!t.parent_span_id);
    const children = traceData.filter(t=>t.parent_span_id);
    const traceEls = roots.map(r=>{
      const kids = children.filter(c=>c.parent_span_id===r.span_id);
      const dur = r.end_time && r.start_time ? (new Date(r.end_time)-new Date(r.start_time))+'ms' : '—';
      return h('div',null,
        h('div',{className:'trace-span'},
          h('span',{className:'span-status '+(r.status==='ok'?'ok':'error')}),
          h('span',{className:'span-name'},r.name||r.trace_id),
          h('span',{className:'span-dur'},dur)
        ),
        ...kids.map(k=>{
          const kd = k.end_time && k.start_time ? (new Date(k.end_time)-new Date(k.start_time))+'ms' : '—';
          return h('div',{className:'trace-span child'},
            h('span',{className:'span-status '+(k.status==='ok'?'ok':'error')}),
            h('span',{className:'span-name'},k.name||'span'),
            h('span',{className:'span-dur'},kd)
          );
        })
      );
    });
    view.appendChild(h('div',{className:'table-wrap',style:'padding:16px;margin-top:16px'},
      h('h3',{style:'margin-bottom:12px'},'Recent Traces'),
      h('div',{className:'trace-tree'},...traceEls)
    ));
  }
  return view;
}

/* ── Init: check if already authenticated ──── */
document.addEventListener('click',()=>{
  if(state.showSettings||state.showProfile||state.showNotifications){
    state.showSettings=false;state.showProfile=false;state.showNotifications=false;render();
  }
});
(async()=>{
  const r = await api.get('/auth/me');
  if(r.ok){
    const d = await r.json();
    state.user = d.user; state.csrfToken = d.csrfToken;
    await loadChats(); await Promise.all([loadModels(), loadTools(), loadUserPreferences()]);
  }
  render();
})();
</script>
</body>
</html>`;
}
