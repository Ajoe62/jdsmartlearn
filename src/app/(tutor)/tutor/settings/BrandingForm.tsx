"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import Callout from "@/components/ui/Callout";
import { Card, CardHeader } from "@/components/ui/Card";
import Field, { CONTROL } from "@/components/ui/Field";
import {
  assertBrandColour,
  DEFAULT_BG,
  MIN_RATIO,
  normaliseHex,
} from "@/lib/branding/colour";
import { MAX_CREST_BYTES, MIN_ICON_PX } from "@/lib/branding/crest";
import { monogram, shortenSchoolName } from "@/lib/branding/monogram";

/**
 * School branding. SCHOOL ADMIN ONLY - the page refuses to render this for a
 * tutor, and /api/tutor/school-branding refuses again server-side.
 *
 * The contrast check runs HERE as well as on the server, from the same pure
 * module. Not a duplicate rule: the same function, so they cannot disagree. It
 * runs on every keystroke because a ratio shown while the admin is still typing
 * is advice, and the same number arriving after a failed save is a telling-off.
 */
export default function BrandingForm({
  schoolId,
  schoolName,
  current,
}: {
  schoolId: string;
  /** ResultPeak's name, for the preview and the placeholder. */
  schoolName: string;
  current: {
    shortName: string | null;
    colorHex: string | null;
    motto: string | null;
    crestUrl: string | null;
    logoIsIcon: boolean;
  };
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [shortName, setShortName] = useState(current.shortName ?? "");
  const [colour, setColour] = useState(current.colorHex ?? "");
  const [motto, setMotto] = useState(current.motto ?? "");
  const [removeLogo, setRemoveLogo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const checked = assertBrandColour(colour);
  const preview = checked.ok ? checked.colour : null;
  const initials = monogram(schoolName);
  const displayName = shortName.trim() || shortenSchoolName(schoolName);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(null);

    const form = new FormData();
    form.set("shortName", shortName);
    form.set("colorHex", colour);
    form.set("motto", motto);
    if (removeLogo) form.set("removeLogo", "1");
    const file = fileRef.current?.files?.[0];
    if (file) form.set("logo", file);

    const res = await fetch("/api/tutor/school-branding", { method: "POST", body: form });
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      iconNote?: string | null;
    };

    if (!res.ok) {
      setError(body.error ?? "Saving didn't finish. Try again.");
      setBusy(false);
      return;
    }

    setSaved(body.iconNote ?? "Saved. Everyone at your school sees this now.");
    setRemoveLogo(false);
    if (fileRef.current) fileRef.current.value = "";
    setBusy(false);
    // The header on this very page is server-rendered, so it only changes on a
    // refresh. Without this the admin saves and sees nothing happen.
    router.refresh();
  }

  return (
    <Card className="mt-8">
      <CardHeader
        title="Your school's look"
        hint="Shown at the top of every screen, to students and staff."
      />

      <div className="space-y-4 p-4">
        {/* The preview is the whole point of this form: an admin should never
            have to save and navigate away to find out what they chose. */}
        <div className="flex items-center gap-3 rounded-lg border border-line bg-canvas p-3">
          <span
            className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg"
            style={{
              background: preview?.bg ?? DEFAULT_BG,
              color: preview?.fg ?? "#FFFFFF",
            }}
          >
            {current.crestUrl && !removeLogo ? (
              /* eslint-disable-next-line @next/next/no-img-element -- our own route */
              <img src={current.crestUrl} alt="" className="h-full w-full object-contain" />
            ) : (
              <span className="font-display text-base font-semibold">{initials}</span>
            )}
          </span>
          <span className="min-w-0">
            <span className="block truncate font-display font-semibold">{displayName}</span>
            <span className="block text-[0.6875rem] text-muted">JDSmartLearn</span>
          </span>
        </div>

        <Field
          label="Crest"
          htmlFor="logo"
          hint={`PNG, JPG or SVG, under ${Math.round(MAX_CREST_BYTES / 1024)} KB. A square PNG of at least ${MIN_ICON_PX}px also becomes the home-screen icon.`}
        >
          <input
            id="logo"
            ref={fileRef}
            type="file"
            accept=".png,.jpg,.jpeg,.svg"
            disabled={removeLogo}
            className={CONTROL}
          />
        </Field>

        {current.crestUrl && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={removeLogo}
              onChange={(e) => setRemoveLogo(e.target.checked)}
            />
            Remove the current crest and go back to the monogram
          </label>
        )}

        {current.crestUrl && !current.logoIsIcon && !removeLogo && (
          <Callout tone="neutral">
            Your crest shows everywhere in the app. A home-screen icon needs a square
            PNG of at least {MIN_ICON_PX}px, so the JDSmartLearn icon is still used
            when someone installs the app.
          </Callout>
        )}

        <Field
          label="Short name"
          htmlFor="shortName"
          hint={`Used where space is tight. Leave empty for "${shortenSchoolName(schoolName)}".`}
        >
          <input
            id="shortName"
            value={shortName}
            onChange={(e) => setShortName(e.target.value)}
            maxLength={40}
            placeholder={shortenSchoolName(schoolName)}
            className={CONTROL}
          />
        </Field>

        <Field
          label="School colour"
          htmlFor="colour"
          hint="Six hex digits, like #1B4D3E. Leave empty to use the default."
        >
          <div className="flex gap-2">
            <input
              id="colour"
              value={colour}
              onChange={(e) => setColour(e.target.value)}
              placeholder={DEFAULT_BG}
              maxLength={9}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className={`${CONTROL} tabular`}
            />
            {/* A native picker alongside the text field: an admin who has a hex
                value types it, one who does not can find their colour. */}
            <input
              type="color"
              aria-label="Pick a colour"
              value={normaliseHex(colour) ?? DEFAULT_BG}
              onChange={(e) => setColour(e.target.value.toUpperCase())}
              className="h-11 w-12 shrink-0 rounded-lg border border-lineInput bg-surface p-1"
            />
          </div>
        </Field>

        {colour.trim() !== "" &&
          (checked.ok ? (
            <p className="text-sm text-muted">
              Contrast {checked.colour.ratio.toFixed(2)}:1 — text on this colour is
              readable. {MIN_RATIO}:1 is the minimum.
            </p>
          ) : (
            /* States the measured ratio rather than just refusing. A darker
               shade of the same colour usually clears it, and the number is what
               tells the admin how far off they are. */
            <Callout tone="danger">{checked.error}</Callout>
          ))}

        <Field
          label="Motto"
          htmlFor="motto"
          hint="Optional. Shown on your school's front door page only."
        >
          <input
            id="motto"
            value={motto}
            onChange={(e) => setMotto(e.target.value)}
            maxLength={120}
            className={CONTROL}
          />
        </Field>

        {error && <Callout tone="danger">{error}</Callout>}
        {saved && <Callout tone="success">{saved}</Callout>}

        <p className="text-sm text-muted">
          Your school&rsquo;s link:{" "}
          <code className="rounded bg-canvas px-1.5 py-0.5 text-[0.8125rem]">/s/{schoolId}</code>{" "}
          — anyone opening it sees your school, and is never asked to choose one.
        </p>

        <Button onClick={save} disabled={busy || !checked.ok} size="lg" full>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </Card>
  );
}
