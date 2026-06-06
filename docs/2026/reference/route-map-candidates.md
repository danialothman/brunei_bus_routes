# 2026 ↔ 2016 route-KML mapping (candidates)

Working notes for transferring 2016 route geometry (KML paths) to the 2026
network. The 2026 stop data has no coordinates, but where a 2016 route still
runs the same corridor, its KML LineString is reusable as-is.

**Important:** the networks were renumbered — 2016 route numbers do **not**
correspond to 2026 numbers (e.g. 2016 `#20` = "Rimba – Lambak Kiri" but 2026
`20` = "→ Batu Bersurat"). Match by corridor / place names, not number.

**What transfers:** the path geometry (what the app draws and the bus rides
along). The stop placemarks keep their **2016 labels/positions** — those still
need to be re-labelled with the official 2026 stop names later.

Candidates below were ranked by place-name overlap between each 2026 route
(title + summary + stops) and each 2016 route KML (filename + placemark names).
Edit the **Confirmed** / **Status** columns as you sift.

## Status legend
- `DONE` — copied to `static/data/2026/kml/<id>.kml`
- `PICK` — plausible corridor, but choose among a family of 2016 variants
- `NEW?` — likely new in 2026, no clean 2016 equivalent (verify)

## Transferred (strong match — already done)

| 2026 | Title | 2016 KML source | Status |
|------|-------|-----------------|--------|
| 01A | Mabohai → Mall Gadong | `1. BSB Circular (A).kml` | DONE |
| 01C | Sumbiling → Mall Gadong | `2. BSB Circular (C).kml` | DONE |
| 24  | RPN Lambak Kanan | `17. Serusop - Lambak Kanan.kml` | DONE |
| 49  | Kg Bunut → Mulaut (Bebatik) | `23. Jame' - Bebatik.kml` | DONE |
| 56  | Kg Lugu | `27. Lugu Route.kml` | DONE |
| 57  | Pasar Jerudong via Katok/Rimba/Empire | `4. Empire Route.kml` | DONE |

## Plausible — confirm / pick the variant

| 2026 | Title | Candidate 2016 KML(s) | Confirmed | Status |
|------|-------|-----------------------|-----------|--------|
| 21 | Kg. Tungku | `26. Jame' - Tungku.kml` | | PICK |
| 22 | Rimba / ITB / UBD / JIS | `15. Jame' - Rimba.kml` · `4. Empire Route.kml` | | PICK |
| 23 | RPN Lambak Kiri & Berakas Kem | `20. Rimba - Lambak Kiri.kml` | | PICK |
| 42 | Kuala Lurah (via Mulaut/L. Manis) | `10 / 11 / 19. Kuala Lurah 01/02/03.kml` | | PICK |
| 44 | Kuala Lurah (via Bengkurong Masin) | `10 / 11 / 19. Kuala Lurah 01/02/03.kml` | | PICK |
| 45 | Mulaut / Limau Manis | `12. Kilanas Circle.kml` · Kuala Lurah family | | PICK |
| 37 | Pekan Muara (Subok / Sg Akar) | Muara family: `6 / 7 / 8.kml`, `16. Muara Express.kml`, `28. Muara Circle.kml` | | PICK |
| 38 | Pekan Muara (Kumbang Pasang / Airport) | Muara family (as above) | | PICK |
| 39 | Pekan Muara (Kota Batu / Mentiri) | Muara family (the Kota Batu / Mentiri one) | | PICK |
| 55 | Pasar Jerudong via Sengkurong | `13 / 18. Jerudong 01/02.kml` | | PICK |
| 58 | Pasar Jerudong via Rimba/Empire | `4. Empire Route.kml` · `15. Jame' - Rimba.kml` | | PICK |

## Likely new in 2026 — verify (only matched on generic downtown stops)

| 2026 | Title | Notes |
|------|-------|-------|
| 20 | → Batu Bersurat | no clean 2016 corridor |
| 35 | → Kg Sungai Akar | short/new route |
| 36 | ICC / Stadium → Airport | specific new corridor |

## Transfer mechanism (per confirmed pairing)
1. Copy the 2016 KML into `static/data/2026/kml/` renamed to the 2026 id
   (e.g. `27. Lugu Route.kml` → `56.kml`).
2. Regenerate `static/data/2026/routes.json` (the filename list the app serves).
3. Once enough routes are in place, flip `DATA_YEAR = "2026"` in `app.py`.

**Note:** `DATA_YEAR` is still `"2016"` — the app continues serving the full
2016 set. The 2026 folder is being staged and is not live until the switch.
