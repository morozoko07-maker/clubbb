# Start here

Two parts: **A** gets the site running on your laptop, **B** puts it on GitHub.

---

## A. Open it on your laptop

### 1. Unzip
Move `clubbb.zip` somewhere easy (for example Desktop or Documents), then:
- **Windows**: right-click → **Extract All…** → **Extract**
- **Mac**: double-click the zip

You now have a folder called `clubbb`.

### 2. Install Python (once)
1. Go to <https://www.python.org/downloads/> and install the latest Python 3.
2. **Windows only:** on the first installer screen, tick **"Add python.exe to PATH"**.
3. Check it worked. Open a terminal (Windows: **Command Prompt**; Mac: **Terminal**) and type:
   ```
   python --version
   ```
   (on Mac: `python3 --version`). You should see `Python 3.x.x`.

### 3. Start the site
- **Windows**: open the `clubbb` folder and double-click **`start.bat`**.
- **Mac**: open Terminal, type `cd ` (with a space), drag the `clubbb` folder into the
  Terminal window, press Enter, then run:
  ```
  ./start.sh
  ```
  If it says "permission denied", run `chmod +x start.sh` once, then `./start.sh` again.

Your browser opens **http://localhost:8770**. If it doesn't, open that address yourself.
The window that stays open is the server: **leave it open** while you use the site and
**close it (or press Ctrl + C)** to stop.

The first start adds demo clubs and events. The window also shows:
- an **Admin:** link, to approve clubs that register and change the campus code
- the **Campus code**: students type it once to RSVP, apply or register a club. Share it on posters or in class groups.

To try the club side: menu → **Club login**, email `hello@codecell.example.com`, password `clubbb-demo`.

### Something went wrong?
| Message | Fix |
|---|---|
| `'python' is not recognized` | Reinstall Python and tick "Add python.exe to PATH" |
| `Address already in use` | The site is already running in another window; use that one or close it |
| Page looks unstyled / plain fonts | You're offline; fonts load from Google Fonts |
| Want to reset the demo data | Stop the site, delete `clubportal/portal.db`, start again |

---

## B. Put it on GitHub

### Option 1: in the browser (no installs)
1. Sign in at <https://github.com> → top-right **+** → **New repository**.
2. Name it `clubbb`. Leave "Add a README" **unticked** (you already have one). Click **Create repository**.
3. On the next page click **"uploading an existing file"**.
4. Open your `clubbb` folder, select **everything inside it** (not the folder itself), and drag it
   into the browser.
   - Hidden files like `.gitignore` may not show. Windows: File Explorer → View → **Hidden items**.
     Mac: press **Cmd + Shift + .** in Finder.
5. Click **Commit changes**. Your README shows on the repository's front page.

> Don't upload `portal.db`, `.admin_key`, `.secret_key`, `.campus_code` or a `data` folder if they exist (they appear after you
> run the site). They hold your local data and admin key. Option 2 skips them automatically.

### Option 2: with Git (recommended)
1. Install Git: <https://git-scm.com/downloads>.
2. Create an empty repository on GitHub as in Option 1, steps 1–2. Copy its address,
   e.g. `https://github.com/YOUR-NAME/clubbb.git`.
3. In a terminal, inside the `clubbb` folder:
   ```
   git init
   git add .
   git commit -m "First version of Clubbb"
   git branch -M main
   git remote add origin https://github.com/YOUR-NAME/clubbb.git
   git push -u origin main
   ```
   GitHub may ask you to sign in; follow the prompt.
4. Later changes:
   ```
   git add .
   git commit -m "Describe what you changed"
   git push
   ```

`.gitignore` keeps your database, admin key and uploads out of GitHub.

### Optional
- **Licence**: on GitHub, **Add file → Create new file**, name it `LICENSE`, then pick a template.
  Choose one yourself; the Credits section of the README explains the Type Garden part.
- **Going live**: GitHub stores the code, but it can't run the site (GitHub Pages only serves
  static pages). To put it online, see **Hosting** in `README.md`.
