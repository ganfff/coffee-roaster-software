"""Compatible source entry point; the packaged executable uses device_main.run."""
from device_main import create_app, run

if __name__ == "__main__":
    run()
else:
    app = create_app()
