# Office のテスト用ファイル

`lib/office.js`(Excel/Word/PowerPoint → 概要プレビュー + 全文検索用テキスト)の検証に使う実ファイルです。
手書きのXMLではなく、実際のアプリが書き出す構造で検証するため、openpyxl / python-docx / python-pptx で生成しています。

| ファイル | 中身 |
|---|---|
| `sample.xlsx` | 3シート(日付・数値・数式・真偽値、350行超の大きい表) |
| `sample.docx` | 見出し(2階層)・本文・箇条書き・3×3の表 |
| `sample.pptx` | 3スライド(タイトル・箇条書き・テキストボックス・発表者ノート) |

作り直す場合は次を実行してください(中身を変えるとテストの期待値も変わります)。

```bash
pip install openpyxl python-docx python-pptx
python tools/make-office-fixtures.py test/fixtures/office
```
