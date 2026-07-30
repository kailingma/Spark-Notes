import {
  Brain,
  ChevronRight,
  Code,
  Columns2,
  Columns3,
  FileText,
  Folder,
  FolderPlus,
  GraduationCap,
  GripVertical,
  History,
  Info,
  Keyboard,
  List,
  ListTree,
  Maximize2,
  Menu,
  Mic,
  Minimize2,
  Minus,
  Moon,
  Paintbrush,
  Palette,
  PanelLeft,
  PanelRight,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  PenLine,
  PictureInPicture2,
  Plus,
  Puzzle,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  SquareCheck,
  Sun,
  SunMoon,
  Tag,
  Terminal,
  TextQuote,
  Trash2,
  Type,
  X,
  Zap,
  type LucideProps,
} from 'lucide-react';

/**
 * Icons.
 *
 * Thin aliases over **lucide** rather than hand-drawn strokes. The set was
 * drawn by hand once, and every icon added afterwards was a small act of
 * matching a weight, a corner radius and an optical size by eye — which is a
 * design job, done badly, in the middle of feature work. A library does it
 * once and consistently, and lucide's 24×24 grid and stroke-first drawing are
 * the system that was being approximated anyway.
 *
 * Everything is re-exported under the app's own names. That keeps the call
 * sites reading as what they *mean* (`PageIcon`, `SparkIcon`) rather than what
 * they happen to be drawn as, so swapping one glyph for a better match is a
 * one-line change here and nowhere else.
 *
 * Stroke width, size and colour all come from `.icon-button svg` and its
 * siblings in `app.css`. CSS beats an SVG presentation attribute, so lucide's
 * own `stroke-width="2"` is overridden rather than fought with.
 */

/** Anything drawn in the chrome takes the same props lucide's own icons do. */
type IconProps = LucideProps;

export const MenuIcon = (props: IconProps) => <Menu {...props} />;
export const SidebarOpenIcon = (props: IconProps) => <PanelRightOpen {...props} />;
export const SidebarCloseIcon = (props: IconProps) => <PanelRightClose {...props} />;
export const SearchIcon = (props: IconProps) => <Search {...props} />;
export const PlusIcon = (props: IconProps) => <Plus {...props} />;
export const TaskIcon = (props: IconProps) => <SquareCheck {...props} />;
export const TagIcon = (props: IconProps) => <Tag {...props} />;
export const MicIcon = (props: IconProps) => <Mic {...props} />;
export const CloseIcon = (props: IconProps) => <X {...props} />;
export const SunIcon = (props: IconProps) => <Sun {...props} />;
export const MoonIcon = (props: IconProps) => <Moon {...props} />;

/**
 * Following the system.
 *
 * A sun crossed with a crescent, rather than a monitor: the theme button cycles
 * *this* dial — light, dark, or whatever the machine says — and a screen glyph
 * would describe the device instead of the choice. It is also the one shape in
 * the row that cannot be mistaken for a control of its own, which a rounded
 * rectangle inside a rounded rectangle very much can.
 */
export const SystemThemeIcon = (props: IconProps) => <SunMoon {...props} />;

export const SparkIcon = (props: IconProps) => <Sparkles {...props} />;

/**
 * Quick capture. A bolt rather than a pen: the box is about getting a thought
 * out before it goes, and the pen already means "editing" in the settings rail.
 */
export const CaptureIcon = (props: IconProps) => <Zap {...props} />;

/**
 * Stop.
 *
 * Outlined rather than filled, because `fill` is set by the stylesheet for
 * every icon in the chrome and a `fill` attribute here would lose to it. The
 * square on its own is the universal symbol anyway, and the button it sits in
 * is already red and pulsing while a recording is running.
 */
export const StopIcon = (props: IconProps) => <Square {...props} />;

/*
 * The font switcher.
 *
 * Three faces, three glyphs about type rather than three renderings of the
 * faces themselves: a letterform for sans, a quoted passage for serif — which
 * is what a serif face is *for* — and a code bracket for mono.
 *
 * The fourth is not a face at all. Curated means "whatever this theme was
 * designed to be read in", so it gets the palette — the glyph of *someone having
 * chosen* — rather than a fourth letterform, which would imply a fourth font.
 */
export const SansIcon = (props: IconProps) => <Type {...props} />;
export const SerifIcon = (props: IconProps) => <TextQuote {...props} />;
export const MonoIcon = (props: IconProps) => <Code {...props} />;
export const CuratedIcon = (props: IconProps) => <Palette {...props} />;

export const SettingsIcon = (props: IconProps) => <Settings {...props} />;
export const SyncIcon = (props: IconProps) => <RefreshCw {...props} />;

/* The surfaces: a split, a window, and the states a window can be in. */

export const SplitIcon = (props: IconProps) => <Columns2 {...props} />;
export const FloatIcon = (props: IconProps) => <PictureInPicture2 {...props} />;
export const MaximizeIcon = (props: IconProps) => <Maximize2 {...props} />;
export const RestoreIcon = (props: IconProps) => <Minimize2 {...props} />;
export const MinimizeIcon = (props: IconProps) => <Minus {...props} />;
/** The handle you drag a tile by when it has no tab to grab. */
export const GripIcon = (props: IconProps) => <GripVertical {...props} />;
/** The right-hand rail, which is where Spark lives. */
export const PanelIcon = (props: IconProps) => <PanelRight {...props} />;

/*
 * The navigator, and its three ways of showing the same space: a hierarchy, a
 * flat list, and columns that walk into it one level at a time.
 */

export const NavigatorIcon = (props: IconProps) => <PanelLeft {...props} />;
export const TreeIcon = (props: IconProps) => <ListTree {...props} />;
export const ListIcon = (props: IconProps) => <List {...props} />;
export const ColumnsIcon = (props: IconProps) => <Columns3 {...props} />;
export const FolderIcon = (props: IconProps) => <Folder {...props} />;
export const FolderPlusIcon = (props: IconProps) => <FolderPlus {...props} />;
export const ChevronIcon = (props: IconProps) => <ChevronRight {...props} />;

/**
 * A page.
 *
 * `FileText` rather than a bare document outline: ruled lines are what makes a
 * rectangle read as a sheet of paper with writing on it at 16px, and every row
 * in the navigator is a page of prose.
 */
export const PageIcon = (props: IconProps) => <FileText {...props} />;

/* Settings sections. Each is the thing it configures, not a generic gear. */

export const GeneralIcon = (props: IconProps) => <SlidersHorizontal {...props} />;
/** Appearance: a brush, because the tab is theme and type, not type alone. */
export const AppearanceIcon = (props: IconProps) => <Paintbrush {...props} />;
export const PenIcon = (props: IconProps) => <PenLine {...props} />;
export const KeyboardIcon = (props: IconProps) => <Keyboard {...props} />;
export const PluginIcon = (props: IconProps) => <Puzzle {...props} />;
export const InfoIcon = (props: IconProps) => <Info {...props} />;
export const ShieldIcon = (props: IconProps) => <ShieldCheck {...props} />;
export const SendIcon = (props: IconProps) => <Send {...props} />;
export const HistoryIcon = (props: IconProps) => <History {...props} />;
export const TrashIcon = (props: IconProps) => <Trash2 {...props} />;

/* Spark's longer reach: what it remembers, what it can be handed, what it runs. */

/** Memory: a brain rather than a database, because the page is about knowing. */
export const MemoryIcon = (props: IconProps) => <Brain {...props} />;
export const AttachIcon = (props: IconProps) => <Paperclip {...props} />;
export const SkillIcon = (props: IconProps) => <GraduationCap {...props} />;
export const TerminalIcon = (props: IconProps) => <Terminal {...props} />;
