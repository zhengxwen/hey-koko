# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Xiuwen Zheng
#
# News-feed article extractor (hey-koko news layer). Reads a raw HTML document from
# stdin, the article's URL as argv[1], and prints ONE JSON object to stdout:
#   { markdown, title, author, date, description, sitename, image, categories[], tags[] }
# It uses `trafilatura` — a site-agnostic boilerplate remover that keeps the main article
# body (dropping nav / "Related news" / share widgets), rewrites <img> to markdown with
# ABSOLUTE urls (url= is passed so relative srcs resolve), and pulls page metadata
# (author / publish date / og:image / categories / tags). Any failure prints
# {"error": "..."} with a non-zero exit so the Node caller can surface it to the user.
import sys
import json


def as_list(v):
    if v is None:
        return []
    if isinstance(v, (list, tuple)):
        return [str(x).strip() for x in v if str(x).strip()]
    # trafilatura sometimes joins terms with ", " or "; "
    parts = [p.strip() for p in str(v).replace(";", ",").split(",")]
    return [p for p in parts if p]


def field(obj, name):
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


def main():
    url = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else None
    html = sys.stdin.buffer.read().decode("utf-8", "replace")
    if not html.strip():
        print(json.dumps({"error": "empty input"}))
        sys.exit(2)

    try:
        import trafilatura
        from trafilatura import bare_extraction
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": "trafilatura not installed: %s" % e}))
        sys.exit(3)

    # Body as GitHub-flavoured markdown, images kept (![](abs-url)), links flattened to
    # plain text, comments/nav/related dropped. favor_recall KEEPS body images that precision
    # mode silently drops (lazy-loaded / caption-wrapped figures — e.g. NVIDIA's cat-306.png) and
    # stays clean on company blogs (no stray "Related" cards in testing); the image loss under
    # precision mattered more than its slightly tidier boundaries for this news use case.
    try:
        body = trafilatura.extract(
            html,
            url=url,
            output_format="markdown",
            include_images=True,
            include_links=False,
            include_comments=False,
            include_tables=True,
            favor_recall=True,
        ) or ""
    except TypeError:
        # Older trafilatura without output_format="markdown" — degrade to txt (no images).
        body = trafilatura.extract(html, url=url, include_comments=False) or ""
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": "extract failed: %s" % e}))
        sys.exit(4)

    # Metadata pass. bare_extraction returns a Document (newer) or dict (older); handle both.
    d = None
    try:
        d = bare_extraction(html, url=url, with_metadata=True, include_images=True)
    except TypeError:
        try:
            d = bare_extraction(html, url=url)
        except Exception:  # noqa: BLE001
            d = None
    except Exception:  # noqa: BLE001
        d = None

    out = {
        "markdown": body,
        "title": (field(d, "title") or "") or "",
        "author": (field(d, "author") or "") or "",
        "date": (field(d, "date") or "") or "",
        "description": (field(d, "description") or "") or "",
        "sitename": (field(d, "sitename") or "") or "",
        "image": (field(d, "image") or "") or "",
        "categories": as_list(field(d, "categories")),
        "tags": as_list(field(d, "tags")),
    }
    sys.stdout.write(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
