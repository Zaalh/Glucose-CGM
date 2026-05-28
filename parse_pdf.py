import pdfplumber
import json
import sys

def parse_pdf(file_path):
    data = []
    with pdfplumber.open(file_path) as pdf:
        for i, page in enumerate(pdf.pages):
            text = page.extract_text()
            if text:
                data.append({"page": i+1, "text": text[:200]})
    print(json.dumps(data, indent=2))

if __name__ == "__main__":
    parse_pdf("Gijs-JanKool_28-05-2026.pdf")
