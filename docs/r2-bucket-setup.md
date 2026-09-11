# R2 bucket setup for direct uploads

Since 2026-09-11 files go from the browser **straight to R2**, not through our
server. A Vercel function refuses any request or response over 4.5 MB, which is
what broke every upload of a larger lesson file or scheme of work. The browser
now PUTs to a presigned address and a route claims the upload
(`src/lib/storage/uploads.ts`); downloads over 4 MB are a redirect to a
ten-minute presigned address (`src/lib/storage/serve.ts`). See
[ARCHITECTURE.md](ARCHITECTURE.md#how-files-move).

A browser will only talk to R2 if the bucket allows it (CORS), and uploads that
nobody claims need clearing up (lifecycle). **Both are one-time settings in the
Cloudflare dashboard, and until CORS is set every upload fails.** Set them
BEFORE deploying the direct-upload change.

## 1. CORS

Cloudflare dashboard → R2 → `jdsmartlearn-files` → Settings → CORS policy →
Edit, and paste:

```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

- **PUT** is the upload. **GET** and **HEAD** are "Save it for offline" on a
  student's phone, which follows the download redirect for a file over 4 MB.
- **ExposeHeaders `ETag`** is required for files over 8 MB. They upload in parts,
  and the browser must read each part's ETag to finish. Without it small files
  upload and large ones fail with "File storage isn't set up for large files yet."
- **Why `*` rather than a list of origins.** CORS protects nothing here: no
  object in this bucket can be read or written without a signature, and
  signatures are only minted by our routes after they check the session, school,
  class and subject. A school can also be reached on its own address
  ([school-addresses.md](school-addresses.md)), so a fixed list would silently
  break uploads for the next address someone adds. If you want a list anyway,
  include the production domain, every school address, `http://localhost:3000`,
  and any preview URL you test on.

## 2. Lifecycle rules

Same bucket → Settings → Object lifecycle rules → Add rule:

| Field | Value |
|---|---|
| Name | `staging-uploads` |
| Prefix | `uploads/` |
| Delete objects | after **1 day** |
| Abort incomplete multipart uploads | after **1 day** |

`uploads/` holds files the browser has put in storage that no lesson, scheme,
assignment or submission has claimed - a tutor who closed the tab halfway
through a form. A claimed file is copied to its permanent key and the staging
copy deleted at once, so nothing a school relies on ever lives under `uploads/`.

**The prefix must be exactly `uploads/`.** A delete rule with no prefix would
remove EVERY file in the bucket after a day - lesson files, schemes of work,
assignment question sheets and students' submitted work alike. `npm run check:r2`
fails if it finds one (when the token is allowed to read the rules).

## 3. Check

```
npm run check:r2
npm run check:r2 -- https://your-production-domain
```

Read-only: it reads the CORS and lifecycle settings, reports, and changes
nothing. If the R2 token cannot read bucket settings (an Object Read & Write
token often cannot), it says so. Check the dashboard by eye against this page
instead.

## 4. Prove it on a preview deployment

The 4.5 MB limit exists only on Vercel, not in `npm run dev`, so a local test
cannot show the fix. On a preview deployment: upload a lesson PDF over 10 MB and
a scheme of work over 50 MB, open both as the tutor, publish them, and open both
as a student in that class.
