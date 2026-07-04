/**
 * ui-i18n-catalog.ts — the BASE catalog of translatable UI strings (m145).
 *
 * The web UI is served as raw modules, so the catalog lives here (server-side): `GET /api/me/i18n` serves the
 * EFFECTIVE messages for the reader's locale (base `en` + any built-in locale + the workspace's AI-generated
 * locale pack). `en` is the source of truth an admin can auto-translate to a new language (the values are what
 * the `translate_ui` tool feeds to the LLM). Keep keys stable + dotted-namespaced; keep values plain English.
 *
 * This is a REPRESENTATIVE set (nav, common actions, empty states) — enough to prove the whole i18n path
 * end-to-end without a risky big-bang extraction of every string; more keys can be added incrementally.
 */
export type Catalog = Record<string, string>;

export const BASE_LOCALE = 'en';

/** The English source strings. Every other locale is a translation of these (built-in or AI-generated). */
export const EN_MESSAGES: Catalog = {
  // Left navigation
  'nav.home': 'Home',
  'nav.calendar': 'Calendar',
  'nav.notes': 'Notes',
  'nav.design': 'Design',
  'nav.builder': 'Builder',
  'nav.dashboard': 'Dashboard',
  'nav.connectors': 'Connectors',
  'nav.validation': 'Validation',
  'nav.admin': 'Admin',
  'nav.recentChats': 'Recent chats',
  // Common actions
  'action.newChat': 'New Chat',
  'action.send': 'Send',
  'action.stop': 'Stop',
  'action.cancel': 'Cancel',
  'action.save': 'Save',
  'action.delete': 'Delete',
  'action.retry': 'Retry',
  'action.docs': 'Docs',
  // Chat
  'chat.placeholder': 'Type a message...',
  'chat.emptyTitle': 'Start a conversation with geneWeave',
  'chat.emptySubtitle': 'Choose a model above and type your message',
  'chat.searchPlaceholder': 'Search chats...',
  'chat.noSavedChats': 'No saved chats yet',
  // Notes
  'notes.searchPlaceholder': 'Search notes',
  'notes.newNote': 'New note',
  'notes.emptyList': 'No notes yet — start one below.',
  'notes.selectToEdit': 'Select a note to start editing',
  // Loading + status
  'status.loading': 'Loading…',
  'status.loadingDashboard': 'Loading dashboard…',
  'status.loadingNotes': 'Loading your notes…',
};

/** A hand-authored Spanish translation (so `es` works with no AI). Region variants fall back to this via BCP-47. */
export const ES_MESSAGES: Catalog = {
  'nav.home': 'Inicio',
  'nav.calendar': 'Calendario',
  'nav.notes': 'Notas',
  'nav.design': 'Diseño',
  'nav.builder': 'Constructor',
  'nav.dashboard': 'Panel',
  'nav.connectors': 'Conectores',
  'nav.validation': 'Validación',
  'nav.admin': 'Administración',
  'nav.recentChats': 'Chats recientes',
  'action.newChat': 'Nuevo chat',
  'action.send': 'Enviar',
  'action.stop': 'Detener',
  'action.cancel': 'Cancelar',
  'action.save': 'Guardar',
  'action.delete': 'Eliminar',
  'action.retry': 'Reintentar',
  'action.docs': 'Docs',
  'chat.placeholder': 'Escribe un mensaje...',
  'chat.emptyTitle': 'Inicia una conversación con geneWeave',
  'chat.emptySubtitle': 'Elige un modelo arriba y escribe tu mensaje',
  'chat.searchPlaceholder': 'Buscar chats...',
  'chat.noSavedChats': 'Aún no hay chats guardados',
  'notes.searchPlaceholder': 'Buscar notas',
  'notes.newNote': 'Nueva nota',
  'notes.emptyList': 'Aún no hay notas: crea una abajo.',
  'notes.selectToEdit': 'Selecciona una nota para empezar a editar',
  'status.loading': 'Cargando…',
  'status.loadingDashboard': 'Cargando el panel…',
  'status.loadingNotes': 'Cargando tus notas…',
};

/** Built-in locales (no AI needed). AI-generated packs (tenant_ui_translations) layer on top of these. */
export const BUILTIN_MESSAGES: Record<string, Catalog> = {
  en: EN_MESSAGES,
  es: ES_MESSAGES,
};
