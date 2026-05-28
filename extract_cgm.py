import pdfplumber
import json
import re
import datetime

def month_to_num(m):
    m = m.lower().replace('.', '')
    months = {
        'jan': 1, 'feb': 2, 'mrt': 3, 'apr': 4,
        'mei': 5, 'jun': 6, 'jul': 7, 'aug': 8,
        'sep': 9, 'okt': 10, 'nov': 11, 'dec': 12
    }
    return months.get(m, 1)

def parse_pdf_to_entries(pdf_path):
    entries = []
    current_date = None
    current_max = None
    current_min = None
    
    with pdfplumber.open(pdf_path) as pdf:
        # Loop over daily log pages (based on the PDF structure)
        for page_num in range(6, min(41, len(pdf.pages))):
            page = pdf.pages[page_num]
            words = page.extract_words()
            
            lines = []
            words.sort(key=lambda w: (w['top'], w['x0']))
            for w in words:
                added = False
                for line in lines:
                    if abs(line[0]['top'] - w['top']) < 5:
                        line.append(w)
                        added = True
                        break
                if not added:
                    lines.append([w])
            
            for line in lines:
                line.sort(key=lambda w: w['x0'])
                text = ' '.join(w['text'] for w in line)
                
                m = re.search(r'(?:MA|DI|WO|DO|VR|ZA|ZO)\.\s+(\d{1,2})\s+([a-z]{3}\.?)', text, re.IGNORECASE)
                if m:
                    day = int(m.group(1))
                    month = month_to_num(m.group(2))
                    year = 2026
                    current_date = datetime.date(year, month, day)
                
                if 'Max ' in text and current_date:
                    try:
                        parts = text.split('Max ')[1].split()
                        nums = [float(p.replace(',', '.')) for p in parts if p.replace(',', '').isdigit()]
                        if len(nums) >= 24:
                            current_max = nums[:24]
                    except:
                        pass
                
                if 'Min ' in text and current_date:
                    try:
                        parts = text.split('Min ')[1].split()
                        nums = [float(p.replace(',', '.')) for p in parts if p.replace(',', '').isdigit()]
                        if len(nums) >= 24:
                            current_min = nums[:24]
                    except:
                        pass
                
                if current_date and current_max and current_min:
                    for hour in range(24):
                        max_val = current_max[hour]
                        min_val = current_min[hour]
                        
                        dt_min = datetime.datetime(current_date.year, current_date.month, current_date.day, hour, 0, 0, tzinfo=datetime.timezone.utc)
                        dt_min = dt_min - datetime.timedelta(hours=2) # Adjust for local time -> UTC assuming summer time
                        
                        dt_min_str = dt_min.isoformat().replace('+00:00', '.000Z')
                        entries.append({
                            "type": "sgv",
                            "date": int(dt_min.timestamp() * 1000),
                            "dateString": dt_min_str,
                            "sgv": round(min_val * 18.0182),
                            "direction": "Flat",
                            "device": "glucose-cgm-pdf-history",
                            "identifier": f"glucose-cgm-pdf:{dt_min_str}"
                        })
                        
                        if max_val != min_val:
                            dt_max = dt_min + datetime.timedelta(minutes=30)
                            dt_max_str = dt_max.isoformat().replace('+00:00', '.000Z')
                            entries.append({
                                "type": "sgv",
                                "date": int(dt_max.timestamp() * 1000),
                                "dateString": dt_max_str,
                                "sgv": round(max_val * 18.0182),
                                "direction": "Flat",
                                "device": "glucose-cgm-pdf-history",
                                "identifier": f"glucose-cgm-pdf:{dt_max_str}"
                            })
                    
                    current_max = None
                    current_min = None
                    current_date = None

    return entries

if __name__ == "__main__":
    entries = parse_pdf_to_entries("Gijs-JanKool_28-05-2026.pdf")
    print(f"Extracted {len(entries)} entries from PDF.")
    with open("cgm_entries.json", "w") as f:
        json.dump(entries, f, indent=2)
