import json
import urllib.request
import hashlib

def sha1hex(value):
    return hashlib.sha1(value.encode('utf-8')).hexdigest()

with open('cgm_entries.json', 'r') as f:
    entries = json.load(f)

# Upload in chunks of 500
chunk_size = 500
api_secret = 'change-me-local-nightscout'
hashed_secret = sha1hex(api_secret)

url = 'http://localhost:1337/api/v1/entries'
headers = {
    'Content-Type': 'application/json',
    'api-secret': hashed_secret
}

for i in range(0, len(entries), chunk_size):
    chunk = entries[i:i+chunk_size]
    data = json.dumps(chunk).encode('utf-8')
    req = urllib.request.Request(url, data=data, headers=headers, method='POST')
    try:
        with urllib.request.urlopen(req) as response:
            print(f"Uploaded {len(chunk)} entries. Status: {response.status}")
    except Exception as e:
        print(f"Error uploading chunk: {e}")
        try:
            print(e.read().decode())
        except:
            pass
