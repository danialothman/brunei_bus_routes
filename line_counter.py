import os


def count_lines(file_path):
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            return len(f.readlines())
    except Exception as e:
        print(f"Error reading {file_path}: {e}")
        return 0


def should_count_file(filename):
    # Files to exclude
    exclude_files = {
        "bootstrap.min.js",
        "jquery.min.js",
        "ol3.js",
        "bootstrap.min.css",
        "ol3.css",
        "line_counter.py",  # Exclude self
    }

    # Extensions to count
    valid_extensions = {".py", ".js", ".html", ".css"}

    # Get base filename and extension
    base = os.path.basename(filename)
    _, ext = os.path.splitext(filename)

    # Return True if file should be counted
    return (
        ext in valid_extensions
        and base not in exclude_files
        and "min." not in base  # Exclude minified files
    )


def main():
    total_lines = 0
    file_counts = {}

    # Walk through all directories
    for root, _, files in os.walk("."):
        for file in files:
            file_path = os.path.join(root, file)
            if should_count_file(file_path):
                lines = count_lines(file_path)
                total_lines += lines
                file_counts[file_path] = lines

    # Print results
    print("\nLines of Code Count:")
    print("-" * 60)

    # Group by file extension
    ext_totals = {}
    for file_path, count in file_counts.items():
        ext = os.path.splitext(file_path)[1]
        ext_totals[ext] = ext_totals.get(ext, 0) + count
        print(f"{file_path}: {count} lines")

    print("\nSummary by File Type:")
    print("-" * 60)
    for ext, count in ext_totals.items():
        print(f"{ext[1:].upper()} files: {count} lines")

    print("-" * 60)
    print(f"Total Lines of Code: {total_lines}")


if __name__ == "__main__":
    main()
