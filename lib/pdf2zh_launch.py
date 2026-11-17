#!/usr/bin/env python
"""Launch pdf2zh for one PDF inside the plugin's managed environment.

Three repairs happen before pdf2zh is imported, because pdf2zh imports every
translation backend eagerly and dies before argument parsing if any backend
fails to import:

1. Proxy variables: Windows proxy tools export NO_PROXY lists containing
   bracketed IPv6 literals such as `[::1]`. httpx, which the `ollama` client
   builds at import time, parses those entries as URLs and raises
   `httpx.InvalidURL: Invalid port: ':1]'`. Bracket entries are stripped.
2. The translation cache and downloaded layout model: pdf2zh resolves them with
   `os.path.expanduser('~')`. `PDF2ZH_HOME` redirects that to a directory the
   plugin owns.
3. The Tencent TMT SDK: some published builds ship an empty `models` module, so
   `from tencentcloud.tmt.v20180321.models import TextTranslateRequest` raises
   ImportError and takes down unrelated backends. Placeholders are installed only
   when the real symbols are missing; the Tencent backend stays unusable and
   every other backend keeps working.
"""
from __future__ import annotations

import importlib
import os
import sys
import types

_TENCENT_PKG = 'tencentcloud.tmt.v20180321'


def _sanitize_proxy_env() -> None:
    for name in ('NO_PROXY', 'no_proxy'):
        raw = os.environ.get(name)
        if not raw:
            continue
        kept = [part.strip() for part in raw.split(',') if part.strip() and '[' not in part]
        os.environ[name] = ','.join(kept) if kept else 'localhost,127.0.0.1'


def _prepare_home() -> None:
    target = os.environ.get('PDF2ZH_HOME')
    if not target:
        return
    os.makedirs(target, exist_ok=True)
    os.environ['HOME'] = target
    os.environ['USERPROFILE'] = target


def _install_fake_module(name: str, symbols: dict[str, object]) -> None:
    module = types.ModuleType(name)
    for symbol, value in symbols.items():
        setattr(module, symbol, value)
    sys.modules[name] = module


def _shim_tencent() -> None:
    try:
        from tencentcloud.tmt.v20180321.models import (  # noqa: F401
            TextTranslateRequest,
            TextTranslateResponse,
        )
        from tencentcloud.tmt.v20180321.tmt_client import TmtClient  # noqa: F401
        return
    except Exception:
        pass
    try:
        models = importlib.import_module(f'{_TENCENT_PKG}.models')
    except Exception:
        models = types.ModuleType(f'{_TENCENT_PKG}.models')
        sys.modules[f'{_TENCENT_PKG}.models'] = models
    for name in ('TextTranslateRequest', 'TextTranslateResponse'):
        if not hasattr(models, name):
            setattr(models, name, type(name, (object,), {}))
    try:
        importlib.import_module(f'{_TENCENT_PKG}.tmt_client')
    except Exception:
        _install_fake_module(f'{_TENCENT_PKG}.tmt_client', {'TmtClient': type('TmtClient', (object,), {})})


def main() -> int:
    _sanitize_proxy_env()
    _prepare_home()
    _shim_tencent()
    from pdf2zh.pdf2zh import main as pdf2zh_main  # noqa: PLC0415

    return pdf2zh_main()


if __name__ == '__main__':
    sys.exit(main())
