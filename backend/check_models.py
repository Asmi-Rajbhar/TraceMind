
import os
import requests
from dotenv import load_dotenv

load_dotenv()

api_key = os.getenv("GEMINI_API_KEY")

if not api_key:
    print("Error: GEMINI_API_KEY not found in .env")
    raise SystemExit(1)

url = "https://generativelanguage.googleapis.com/v1beta/models"

response = requests.get(
    url,
    params={"key": api_key},
    timeout=30
)

if response.status_code != 200:
    print("Error:", response.status_code)
    print(response.text)
    raise SystemExit(1)

data = response.json()

print("\nModels supporting text generation:\n")

for model in data.get("models", []):
    methods = model.get("supportedGenerationMethods", [])

    if "generateContent" in methods:
        print(model["name"])
