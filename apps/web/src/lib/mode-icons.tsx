import {
  Atom,
  Battery,
  Bird,
  Bolt,
  Brain,
  Cat,
  CircleDot,
  Cloud,
  Compass,
  Cpu,
  Crown,
  Diamond,
  Feather,
  FlaskConical,
  Flame,
  Gauge,
  Gem,
  Ghost,
  Hammer,
  Heart,
  Hourglass,
  Infinity as InfinityIcon,
  Leaf,
  Lightbulb,
  Microscope,
  Moon,
  Mountain,
  Orbit,
  Squirrel,
  Pencil,
  Plane,
  Rabbit,
  Rocket,
  Scale,
  Ship,
  Snail,
  Sparkle,
  Sprout,
  Star,
  Sun,
  Target,
  Telescope,
  Timer,
  Turtle,
  Wand,
  Waves,
  Wind,
  Zap,
  type LucideProps,
} from 'lucide-react';
import type { ReactElement } from 'react';
import type { IconKind } from './spark-client';

/**
 * The glyphs a model preset can wear.
 *
 * A curated forty-eight, not all of lucide. The full set is over a thousand
 * icons, which needs a search index and a virtualised grid to be usable — and
 * the honest observation is that nobody browses a thousand icons to label
 * "Fast". These are chosen for one job: saying *speed, effort or character* at
 * 14px in a row of chrome. Animals for pace, tools for effort, weather and
 * astronomy for scale, and a handful with no meaning at all because someone will
 * want a cat.
 *
 * They are keyed **by name** because that is what the server stores. A preset in
 * `.spark/spark.json` says `"icon": "Zap"`, which survives a rebuild, syncs as
 * plain text and can be edited by hand — where a component reference could not
 * be any of those. An unknown name falls back rather than throwing: a settings
 * file from a later version must not blank the switcher.
 */
export const MODE_ICONS: Record<string, (props: LucideProps) => ReactElement> = {
  Zap: (p) => <Zap {...p} />,
  Bolt: (p) => <Bolt {...p} />,
  Flame: (p) => <Flame {...p} />,
  Rocket: (p) => <Rocket {...p} />,
  Feather: (p) => <Feather {...p} />,
  Wind: (p) => <Wind {...p} />,
  Plane: (p) => <Plane {...p} />,
  Timer: (p) => <Timer {...p} />,
  Gauge: (p) => <Gauge {...p} />,
  Hourglass: (p) => <Hourglass {...p} />,

  Scale: (p) => <Scale {...p} />,
  Target: (p) => <Target {...p} />,
  Compass: (p) => <Compass {...p} />,
  CircleDot: (p) => <CircleDot {...p} />,
  Battery: (p) => <Battery {...p} />,

  Gem: (p) => <Gem {...p} />,
  Diamond: (p) => <Diamond {...p} />,
  Crown: (p) => <Crown {...p} />,
  Star: (p) => <Star {...p} />,
  Sparkle: (p) => <Sparkle {...p} />,
  Brain: (p) => <Brain {...p} />,
  Microscope: (p) => <Microscope {...p} />,
  Telescope: (p) => <Telescope {...p} />,
  FlaskConical: (p) => <FlaskConical {...p} />,
  Atom: (p) => <Atom {...p} />,
  Cpu: (p) => <Cpu {...p} />,
  Orbit: (p) => <Orbit {...p} />,
  Infinity: (p) => <InfinityIcon {...p} />,

  Hammer: (p) => <Hammer {...p} />,
  Pencil: (p) => <Pencil {...p} />,
  Wand: (p) => <Wand {...p} />,
  Lightbulb: (p) => <Lightbulb {...p} />,

  Snail: (p) => <Snail {...p} />,
  Turtle: (p) => <Turtle {...p} />,
  Rabbit: (p) => <Rabbit {...p} />,
  Bird: (p) => <Bird {...p} />,
  Squirrel: (p) => <Squirrel {...p} />,
  Cat: (p) => <Cat {...p} />,
  Ghost: (p) => <Ghost {...p} />,
  Heart: (p) => <Heart {...p} />,

  Sun: (p) => <Sun {...p} />,
  Moon: (p) => <Moon {...p} />,
  Cloud: (p) => <Cloud {...p} />,
  Waves: (p) => <Waves {...p} />,
  Mountain: (p) => <Mountain {...p} />,
  Leaf: (p) => <Leaf {...p} />,
  Sprout: (p) => <Sprout {...p} />,
  Ship: (p) => <Ship {...p} />,
};

export const MODE_ICON_NAMES = Object.keys(MODE_ICONS);

/**
 * One preset's glyph, whichever kind it is.
 *
 * Emoji are wrapped in a span rather than rendered bare so the two kinds occupy
 * the same box: an emoji is a text glyph with its own baseline and an icon is an
 * SVG with none, and a switcher whose items jump half a pixel as you change the
 * icon is a switcher that looks broken.
 */
export function ModeGlyph({
  icon,
  kind,
  size = 14,
}: {
  icon: string;
  kind: IconKind;
  size?: number;
}) {
  if (kind === 'emoji') {
    return (
      <span className="mode-emoji" style={{ fontSize: `${size}px` }} aria-hidden="true">
        {icon || '•'}
      </span>
    );
  }

  const Glyph = MODE_ICONS[icon];
  // An unknown name is a settings file from a later version, or a typo. A dot is
  // a mode with a boring icon; a crash is a mode switcher nobody can open.
  if (!Glyph) return <CircleDot size={size} aria-hidden="true" />;
  return <Glyph size={size} aria-hidden="true" />;
}
