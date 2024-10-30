from flask import Flask, render_template, send_from_directory, json
import os

app = Flask(
    __name__,
    static_folder="webapp",  # Keep existing static files in place
    template_folder="webapp",
)  # Keep HTML files in place for now


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/data/routes.json")
def get_routes():
    # Read and return routes.json directly as JSON
    routes_path = os.path.join(app.static_folder, "data", "routes.json")
    with open(routes_path, "r") as f:
        return json.load(f)


@app.route("/data/kml/<path:filename>")
def serve_kml(filename):
    # Serve KML files from the data/kml directory
    return send_from_directory(os.path.join(app.static_folder, "data", "kml"), filename)


@app.route("/favicon.ico")
def favicon():
    return send_from_directory(
        app.static_folder, "favicon.ico", mimetype="image/vnd.microsoft.icon"
    )


if __name__ == "__main__":
    app.run(debug=True, port=8000)
