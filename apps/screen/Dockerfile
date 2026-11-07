# syntax=docker/dockerfile:1.10
ARG PYTHON_IMAGE=python:3.12-slim-trixie

FROM ghcr.io/astral-sh/uv:0.13.7 AS uv

FROM ${PYTHON_IMAGE} AS build
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv
WORKDIR /src
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project
COPY src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable

# Chromium headless shell only (no full browser UI), plus the system libraries it needs.
FROM ${PYTHON_IMAGE} AS browser
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
COPY --from=build /opt/venv /opt/venv
RUN /opt/venv/bin/playwright install --with-deps --only-shell chromium \
 && apt-get -y --no-install-recommends upgrade \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/*

FROM browser AS test
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never UV_PROJECT_ENVIRONMENT=/opt/venv
WORKDIR /src
COPY pyproject.toml uv.lock ./
COPY src ./src
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --no-editable
COPY tests ./tests
RUN /opt/venv/bin/ruff check src tests \
    && /opt/venv/bin/ruff format --check src tests \
    && /opt/venv/bin/mypy \
    && /opt/venv/bin/bandit -q -r src \
    && /opt/venv/bin/python -m pytest -p no:cacheprovider --cov-fail-under=90

FROM browser AS runtime
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin screen
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/tmp
USER 10001:10001
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/health', timeout=4)"]
ENTRYPOINT ["meet-impar-screen"]
