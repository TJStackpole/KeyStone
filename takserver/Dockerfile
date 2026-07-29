# WATCHTOWER TAK server — taky (https://github.com/tkuester/taky)
#
# Why taky and not OpenTAKServer / FreeTAKServer: both of the CLAUDE.md-named
# servers shipped broken as of 2026-07 — see "TAK server selection" in the
# README for the full failure log (four configurations tested empirically).
# taky is a real, maintained, open-source TAK server that speaks genuine
# Cursor-on-Target over plain TCP 8087 (and TLS when configured), interops
# with real ATAK/iTAK clients, and correctly fans events out between clients —
# verified end-to-end before adoption. WATCHTOWER's CoT client is
# server-agnostic: pointing TAK_HOST/TAK_PORT at any other TAK server (incl.
# TAK Product Center's TAK Server) requires no code change.
FROM python:3.12-slim

# taky 0.10 imports pkg_resources, removed in setuptools >= 81 — pin below it.
RUN pip install --no-cache-dir "setuptools<81" taky==0.10

EXPOSE 8087

CMD ["taky", "-l", "info"]
