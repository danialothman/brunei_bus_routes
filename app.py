from flask import Flask, render_template, send_from_directory, json
import os

app = Flask(
    __name__,
    static_folder="static",
    template_folder="templates",
)


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
    # First try the static folder
    static_kml_path = os.path.join(app.static_folder, "data", "kml")
    if os.path.exists(os.path.join(static_kml_path, filename)):
        return send_from_directory(static_kml_path, filename)

    # If not found in static, try the data folder
    data_kml_path = os.path.join("data", "kml")
    if os.path.exists(os.path.join(data_kml_path, filename)):
        return send_from_directory(data_kml_path, filename)

    return "KML file not found", 404


@app.route("/favicon.png")
def favicon():
    return send_from_directory(app.static_folder, "favicon.png", mimetype="image/png")


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=8000)
