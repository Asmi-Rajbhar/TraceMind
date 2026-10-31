
import os
from pathlib import Path

from dotenv import load_dotenv
from google import genai
from google.genai import types

load_dotenv(Path(__file__).resolve().parent / ".env")

api_key = os.getenv("GEMINI_API_KEY")
model = os.getenv("GEMINI_MODEL", "gemini-3.8-flash")

if not api_key:
    raise RuntimeError(
        "GEMINI_API_KEY is missing. Check backend/.env"
    )

client = genai.Client(
    api_key=api_key,
    http_options=types.HttpOptions(
        timeout=120000
    ),
)

print("Testing Gemini connection...")
print("Model:", model)

try:
    response = client.models.generate_content(
        model=model,
        contents=(
            "You are testing TraceMind. In two short sentences, "
            "explain how a database connection timeout can cause "
            "a checkout request to fail."
        ),
        config=types.GenerateContentConfig(
            max_output_tokens=150,
        ),
    )

    if not response.text:
        print("Gemini returned no text. Check the model response.")
    else:
        print("\nGemini response:")
        print(response.text)

except Exception as exc:
    print("\nGemini request failed.")
    print("Error type:", type(exc).__name__)
    print("Details:", str(exc))
