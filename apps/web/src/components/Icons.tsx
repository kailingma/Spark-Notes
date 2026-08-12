import {
  Archive,
  ArrowUp,
  Bold,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  ClipboardPaste,
  Clock,
  Code,
  Code2,
  Eye,
  EyeOff,
  Globe,
  Heading2,
  Highlighter,
  IndentIncrease,
  Italic,
  Lightbulb,
  Link2,
  MoreHorizontal,
  Quote,
  RotateCcw,
  SquareCode,
  Undo2,
  Columns2,
  Columns3,
  Compass,
  Copy,
  FileText,
  Folder,
  FolderPlus,
  GraduationCap,
  GripVertical,
  Hand,
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
  Pin,
  PinOff,
  Plus,
  Puzzle,
  RefreshCw,
  Rocket,
  Scissors,
  Search,
  Settings,
  ShieldCheck,
  Slash,
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
  Upload,
  X,
  Zap,
  type LucideProps,
} from 'lucide-react';
import { SparkLogo } from './SparkLogo';

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
/* Capture's own modes, beyond Note and Task above. */
export const IdeaIcon = (props: IconProps) => <Lightbulb {...props} />;
export const QuestionIcon = (props: IconProps) => <CircleHelp {...props} />;
export const LogIcon = (props: IconProps) => <Clock {...props} />;
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

/**
 * Spark.
 *
 * The one icon in the set that is *not* lucide — it is drawn, in `SparkLogo.tsx`,
 * and the reasoning is there. Aliased here anyway so every call site still
 * imports its icons from one place, and so the props are the lucide ones: a
 * `size` and a `className` are all anything passes it.
 */
export const SparkIcon = ({ size, className }: IconProps) => (
  <SparkLogo size={typeof size === 'number' ? size : 16} className={className} />
);

/** The generic "a model did this" glyph, for anything that is not Spark itself. */
export const AiIcon = (props: IconProps) => <Sparkles {...props} />;

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
/** Places: the short list of somewhere to go, rather than everything there is. */
export const PlacesIcon = (props: IconProps) => <Compass {...props} />;
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

/*
 * Acting on what is in the navigator.
 *
 * The clipboard verbs keep their universal glyphs — a rename or a delete can be
 * a word in a menu, but scissors and a clipboard are read faster than either.
 * Upload is an arrow *into* something, not a paperclip: attaching a file to a
 * message (`AttachIcon`) and putting one in the space are different acts and
 * one of them is not reversible by deleting a draft.
 */
/*
 * The chat's own controls.
 *
 * A chevron for anything that opens a list under it, an ellipsis for the
 * overflow — the two shapes people already read as "there is more here" without
 * being told. `RotateCcw` for regenerate rather than a refresh circle, because
 * refresh already means sync in the status bar and the two would collide.
 * `Undo2` for rewind is the same glyph the editor's undo would use, which is the
 * point: rewinding a conversation is undoing your last message.
 */
export const ChevronDownIcon = (props: IconProps) => <ChevronDown {...props} />;
/** Scrolling the tab strip when it overflows. */
export const ChevronLeftIcon = (props: IconProps) => <ChevronLeft {...props} />;
export const ChevronRightIcon = (props: IconProps) => <ChevronRight {...props} />;
export const MoreIcon = (props: IconProps) => <MoreHorizontal {...props} />;
export const RegenerateIcon = (props: IconProps) => <RotateCcw {...props} />;
export const RewindIcon = (props: IconProps) => <Undo2 {...props} />;
export const CheckIcon = (props: IconProps) => <Check {...props} />;
export const WebIcon = (props: IconProps) => <Globe {...props} />;
/** Showing and hiding what the model thought. */
export const ShowIcon = (props: IconProps) => <Eye {...props} />;
export const HideIcon = (props: IconProps) => <EyeOff {...props} />;
/** The permission mode dial: a shield, because it is about what may happen. */
export const PermissionIcon = (props: IconProps) => <ShieldCheck {...props} />;
/** Manual: every call stops and asks — a hand held up. */
export const HandIcon = (props: IconProps) => <Hand {...props} />;
/** Auto: nothing asks, all the way to the end. */
export const RocketIcon = (props: IconProps) => <Rocket {...props} />;

export const CutIcon = (props: IconProps) => <Scissors {...props} />;
export const CopyIcon = (props: IconProps) => <Copy {...props} />;
export const PasteIcon = (props: IconProps) => <ClipboardPaste {...props} />;
export const PinIcon = (props: IconProps) => <Pin {...props} />;
export const PinOffIcon = (props: IconProps) => <PinOff {...props} />;
export const UploadIcon = (props: IconProps) => <Upload {...props} />;

/* Settings sections. Each is the thing it configures, not a generic gear. */

export const GeneralIcon = (props: IconProps) => <SlidersHorizontal {...props} />;
/** Appearance: a brush, because the tab is theme and type, not type alone. */
export const AppearanceIcon = (props: IconProps) => <Paintbrush {...props} />;
export const PenIcon = (props: IconProps) => <PenLine {...props} />;
export const KeyboardIcon = (props: IconProps) => <Keyboard {...props} />;
export const PluginIcon = (props: IconProps) => <Puzzle {...props} />;
export const InfoIcon = (props: IconProps) => <Info {...props} />;
export const ShieldIcon = (props: IconProps) => <ShieldCheck {...props} />;
/**
 * Send.
 *
 * An arrow up, not a paper plane. The composer sits at the bottom of the panel
 * and the message travels up into the transcript directly above it, so the arrow
 * describes where the thing goes — and the plane, which every messaging app uses,
 * says "transmit to someone else", which is not what this does.
 */
export const SendIcon = (props: IconProps) => <ArrowUp {...props} />;
/** Slash commands, drawn as the character you would otherwise type. */
export const SlashIcon = (props: IconProps) => <Slash {...props} />;
export const HistoryIcon = (props: IconProps) => <History {...props} />;
export const TrashIcon = (props: IconProps) => <Trash2 {...props} />;
export const ArchiveIcon = (props: IconProps) => <Archive {...props} />;

/* The mobile markdown toolbar — see `MarkdownToolbar.tsx`. `Code2` rather than
   `Code` (already `MonoIcon`, a font mode) so inline code reads differently
   from a fenced block, which gets its own icon (`SquareCode`) rather than
   sharing one with the inline mark. */
export const HeadingIcon = (props: IconProps) => <Heading2 {...props} />;
export const BoldIcon = (props: IconProps) => <Bold {...props} />;
export const ItalicIcon = (props: IconProps) => <Italic {...props} />;
export const InlineCodeIcon = (props: IconProps) => <Code2 {...props} />;
export const CodeBlockIcon = (props: IconProps) => <SquareCode {...props} />;
export const LinkPageIcon = (props: IconProps) => <Link2 {...props} />;
export const QuoteIcon = (props: IconProps) => <Quote {...props} />;
export const HighlighterIcon = (props: IconProps) => <Highlighter {...props} />;
export const DividerIcon = (props: IconProps) => <Minus {...props} />;
export const IndentIcon = (props: IconProps) => <IndentIncrease {...props} />;

/* Spark's longer reach: what it remembers, what it can be handed, what it runs. */

/** Memory: a brain rather than a database, because the page is about knowing. */
export const MemoryIcon = (props: IconProps) => <Brain {...props} />;
export const AttachIcon = (props: IconProps) => <Paperclip {...props} />;
export const SkillIcon = (props: IconProps) => <GraduationCap {...props} />;
export const TerminalIcon = (props: IconProps) => <Terminal {...props} />;
