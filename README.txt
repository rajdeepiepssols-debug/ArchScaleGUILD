SITELINE + GEMINI SETUP

1. Install Node.js 18+.

2. Put these files in one backend folder:
   server.js
   package.json
   .env.example
   .gitignore

3. Open a terminal in that folder and run:
   npm install

4. Get a Gemini API key from Google AI Studio.

5. Create a file named .env next to server.js.
   Copy this into it:

   GEMINI_API_KEY=YOUR_REAL_KEY_HERE

   Do NOT put the real key inside Siteline-Gemini.html.

6. Start the backend:
   node server.js

7. You should see:
   SiteLine Gemini backend running at http://localhost:3000
   Model: gemini-2.5-flash

8. Open Siteline-Gemini.html using VS Code Live Server.

9. Click Load sample, then Process conversation.

10. Test this URL in the browser:
    http://localhost:3000/api/health

    It should return JSON showing ok: true.

The HTML sends text, screenshots, and PDFs to the local backend. The backend converts the attachment format to Gemini's inline_data format and keeps the API key on the server.
