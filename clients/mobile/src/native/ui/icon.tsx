/**
 * icon.tsx — the single icon chokepoint for the whole mobile app.
 *
 * Every glyph in the UI goes through this component. It is the one place that
 * imports `lucide-react-native`, so the project's icon rules are enforced in
 * exactly one file and can never drift:
 *
 *   • lucide outline icons only — no hand-drawn SVGs, no emoji in chrome, no
 *     mixed icon families.
 *   • strokeWidth = 2, round caps + joins (lucide's built-in geometry), outline
 *     style only — no fills, gradients, shadows, or duotone.
 *   • monochrome: color comes from the resolved theme via {@link useTheme}, never
 *     a hardcoded hex. The semantic `tone` maps to a design token, so per-tenant
 *     theme overrides automatically re-skin every icon.
 *   • sizes snap to the 4pt grid: sm = 20, md = 24 (default), lg = 28.
 *
 * To add an icon: pick the lucide equivalent, give it a semantic name here, and
 * reference that name everywhere. Never import a lucide icon outside this file.
 */
import {
  Archive,
  ArrowUp,
  Apple,
  Bell,
  BellRing,
  Brain,
  CalendarClock,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleUser,
  Database,
  Ellipsis,
  ExternalLink,
  Facebook,
  Github,
  Inbox,
  Info,
  LayoutGrid,
  ListChecks,
  ListTodo,
  LoaderCircle,
  Lock,
  LogOut,
  MessageSquare,
  MessagesSquare,
  Mic,
  MicOff,
  Moon,
  NotebookPen,
  Palette,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Quote,
  RefreshCw,
  Repeat,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Tag,
  Clock,
  Trash2,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react-native';
import { useTheme } from '../providers/theme-provider';
import type { ResolvedAppTheme } from '../../lib';

/** Semantic icon names. Each maps to exactly one curated lucide glyph below. */
export type IconName =
  // tab bar
  | 'chat'
  | 'chats'
  | 'actions'
  | 'profile'
  // conversation list + rows
  | 'search'
  | 'pin'
  | 'unpin'
  | 'archive'
  | 'rename'
  | 'more'
  | 'chevron'
  | 'running'
  | 'pending'
  | 'refresh'
  | 'empty'
  // actions tab
  | 'approval'
  | 'task'
  | 'reminder'
  | 'snooze'
  | 'delete'
  | 'recurring'
  | 'due'
  // shared chrome
  | 'check'
  | 'close'
  | 'send'
  | 'add'
  | 'options'
  | 'error'
  // M8 — profile / memory / settings / voice
  | 'account'
  | 'web'
  | 'locked'
  | 'memory'
  | 'entity'
  | 'authored'
  | 'notifications'
  | 'appearance'
  | 'security'
  | 'data'
  | 'mic'
  | 'micOff'
  | 'signout'
  | 'settings'
  | 'info'
  | 'quiet'
  | 'back'
  // calendar + notes tabs (WC5 / WC10)
  | 'calendar'
  | 'notes'
  // OAuth / social sign-in providers (lucide outline brand glyphs).
  // Google is intentionally absent: its logo is a locked 4-color brand mark
  // rendered by ProviderMark, not a monochrome glyph.
  | 'oauthGithub'
  | 'oauthMicrosoft'
  | 'oauthApple'
  | 'oauthFacebook';

const ICONS: Record<IconName, LucideIcon> = {
  chat: MessageSquare,
  chats: MessagesSquare,
  actions: ListChecks,
  profile: CircleUser,
  search: Search,
  pin: Pin,
  unpin: PinOff,
  archive: Archive,
  rename: Pencil,
  more: Ellipsis,
  chevron: ChevronRight,
  running: LoaderCircle,
  pending: CircleAlert,
  refresh: RefreshCw,
  empty: Inbox,
  approval: ShieldCheck,
  task: ListTodo,
  reminder: BellRing,
  snooze: Clock,
  delete: Trash2,
  recurring: Repeat,
  due: CalendarClock,
  check: Check,
  close: X,
  send: ArrowUp,
  add: Plus,
  options: SlidersHorizontal,
  error: TriangleAlert,
  account: CircleUser,
  web: ExternalLink,
  locked: Lock,
  memory: Brain,
  entity: Tag,
  authored: Quote,
  notifications: Bell,
  appearance: Palette,
  security: ShieldCheck,
  data: Database,
  mic: Mic,
  micOff: MicOff,
  signout: LogOut,
  settings: Settings,
  info: Info,
  quiet: Moon,
  back: ChevronLeft,
  // OAuth providers — lucide has outline brand glyphs for these; Microsoft has
  // no brand glyph, so a neutral grid mark stands in (still outline/monochrome).
  // Google is not here: its official 4-color logo is rendered by ProviderMark.
  calendar: CalendarDays,
  notes: NotebookPen,
  oauthGithub: Github,
  oauthMicrosoft: LayoutGrid,
  oauthApple: Apple,
  oauthFacebook: Facebook,
};

/** Icon sizes snap to the 4pt grid. */
export type IconSize = 'sm' | 'md' | 'lg';
const SIZE_PX: Record<IconSize, number> = { sm: 20, md: 24, lg: 28 };

/**
 * Semantic color roles. Every role resolves to a design token, so the icon set
 * stays monochrome-by-default and re-skins with any per-tenant theme.
 *   inactive  — default resting state (secondary text)
 *   active    — selected / emphasized (primary text)
 *   muted     — de-emphasized hint (muted text)
 *   accent    — active tab indicator + primary action ONLY
 *   attention — pending / needs-attention ONLY (warning/amber)
 *   onAccent  — icon sitting on an accent-filled surface (e.g. send button)
 *   danger    — destructive / error affordance
 */
export type IconTone = 'inactive' | 'active' | 'muted' | 'accent' | 'attention' | 'onAccent' | 'danger';

function toneColor(theme: ResolvedAppTheme['theme'], tone: IconTone): string {
  switch (tone) {
    case 'active':
      return theme.colors.text;
    case 'muted':
      return theme.colors.textMuted;
    case 'accent':
      return theme.colors.accent;
    case 'attention':
      return theme.colors.warning;
    case 'onAccent':
      return theme.colors.onAccent;
    case 'danger':
      return theme.colors.danger;
    case 'inactive':
    default:
      return theme.colors.textSecondary;
  }
}

export interface IconProps {
  name: IconName;
  /** 4pt-grid size. Defaults to `md` (24px). */
  size?: IconSize;
  /** Semantic color role. Defaults to `inactive`. */
  tone?: IconTone;
  /** Explicit color override (e.g. tab bar tint from navigator). Prefer `tone`. */
  color?: string;
}

/** The one and only way to render an icon in the app. */
export function Icon({ name, size = 'md', tone = 'inactive', color }: IconProps) {
  const { theme } = useTheme();
  const Glyph = ICONS[name];
  return (
    <Glyph
      size={SIZE_PX[size]}
      color={color ?? toneColor(theme, tone)}
      strokeWidth={2}
    />
  );
}

/** Raw pixel size for a semantic icon size — handy for layout math (hit slop, rows). */
export function iconSizePx(size: IconSize): number {
  return SIZE_PX[size];
}
