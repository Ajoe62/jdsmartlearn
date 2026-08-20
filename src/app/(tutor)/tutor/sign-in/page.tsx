"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { signInWithEmailAndPassword, signOut } from "firebase/auth";
import { FirebaseError } from "firebase/app";
import { Button } from "@/components/ui/Button";
import Callout from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import Field, { CONTROL } from "@/components/ui/Field";
import { clientAuth } from "@/lib/firebase/client";

/** Auth codes that genuinely mean "wrong email or password". */
const CREDENTIAL_ERRORS = new Set([
  "auth/invalid-credential",
  "auth/wrong-password",
  "auth/user-not-found",
  "auth/invalid-email",
]);

/** Tutors use their existing ResultPeak credentials - same Auth directory. */
export default function TutorSignIn() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      const cred = await signInWithEmailAndPassword(clientAuth, email, password);
      const idToken = await cred.user.getIdToken();
      const res = await fetch("/api/tutor/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken }),
      });
      if (!res.ok) {
        // The password was right but the account may not act (deactivated, no
        // school, still on a temporary password). The server names the reason;
        // show it rather than a generic failure, because "try again" is exactly
        // the wrong advice and every tutor page would bounce back here anyway.
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        await signOut(clientAuth).catch(() => {});
        setError(body?.error ?? "Signing in didn't finish. Try again.");
        setBusy(false);
        return;
      }
      router.push("/tutor");
    } catch (err) {
      if (err instanceof FirebaseError) {
        if (CREDENTIAL_ERRORS.has(err.code)) {
          setError("That email and password don't match.");
        } else if (err.code === "auth/too-many-requests") {
          setError("Too many attempts. Wait a few minutes and try again.");
        } else if (err.code === "auth/network-request-failed") {
          setError("We couldn't reach the network. Check your connection and try again.");
        } else {
          // Configuration problems (bad API key, disabled provider) - not the
          // teacher's fault. Say so instead of blaming their password.
          setError(`Sign-in isn't set up correctly (${err.code}). Contact your administrator.`);
        }
      } else {
        setError("Signing in didn't finish. Try again.");
      }
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-sm px-5 py-12">
      <h1 className="text-title">Sign in</h1>
      <p className="mt-2 text-muted">Use the same details as ResultPeak.</p>

      <Card className="mt-6 space-y-4 p-4">
        <Field label="Email" htmlFor="email">
          <input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={CONTROL}
          />
        </Field>

        <Field label="Password" htmlFor="password">
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={CONTROL}
          />
        </Field>

        {error && <Callout tone="danger">{error}</Callout>}

        <Button onClick={signIn} disabled={busy || !email || !password} size="lg" full>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </Card>
    </main>
  );
}
