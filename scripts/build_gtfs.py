"""Build a GTFS feed zip from the route data and write it to disk.

    python scripts/build_gtfs.py --year 2016 --out gtfs.zip

Shares the exact gathering/build path used by the /data/gtfs.zip endpoint, so
the CLI artifact and the served feed are identical (both include DB edits).
"""
import argparse
import os
import sys

# Import the app package from the repo root regardless of cwd.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app as appmod  # noqa: E402
import gtfs           # noqa: E402


def main():
    ap = argparse.ArgumentParser(description="Build a GTFS feed from route data.")
    ap.add_argument("--year", default="2016", help="dataset year (default: 2016)")
    ap.add_argument("--out", default="gtfs.zip", help="output zip path (default: gtfs.zip)")
    ap.add_argument("--headway", type=int, help="headway seconds (overrides default)")
    ap.add_argument("--start-time", help="service window start HH:MM:SS")
    ap.add_argument("--end-time", help="service window end HH:MM:SS")
    args = ap.parse_args()

    year = appmod._resolve_year(args.year)
    routes, agency, params = appmod.gtfs_feed_inputs(year)
    if not routes:
        sys.exit(f"No exportable routes found for year {year}.")

    if args.headway:
        params["headway_secs"] = args.headway
    if args.start_time:
        params["start_time"] = args.start_time
    if args.end_time:
        params["end_time"] = args.end_time

    data, stats = gtfs.build_feed(routes, agency, params)
    with open(args.out, "wb") as f:
        f.write(data)

    print(f"Wrote {args.out} ({len(data):,} bytes)")
    print(f"  routes:      {stats['routes']} "
          f"({stats['scheduled_routes']} with transcribed departures)")
    print(f"  trips:       {stats['trips']}")
    print(f"  stops:       {stats['stops']} ({stats['merged_stops']} merges)")
    print(f"  stop_times:  {stats['stop_times']}")
    print(f"  shape_points:{stats['shape_points']}")


if __name__ == "__main__":
    main()
