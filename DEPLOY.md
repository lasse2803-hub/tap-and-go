# Deploy Tap & Go

Tre nemme muligheder — vælg den der passer dig bedst.

---

## Option 1: Render (gratis, nemmest)

1. Push dit repo til GitHub
2. Gå til [render.com](https://render.com) → **New Web Service**
3. Forbind dit GitHub-repo
4. Render auto-detecter Node.js:
   - **Build Command**: `npm install`
   - **Start Command**: `node server/index.js`
5. Klik **Deploy**
6. Du får en URL som `https://tap-and-go-xxxx.onrender.com`

> **Bemærk:** Render free tier spinner ned efter 15 min inaktivitet. Første request tager ~30 sek at starte op igen.

---

## Option 2: Fly.io (gratis, hurtigere)

```bash
# Installer flyctl
curl -L https://fly.io/install.sh | sh

# Login
flyctl auth login

# Deploy (fra projekt-mappen)
flyctl launch    # Vælg region: Amsterdam (ams) for EU
flyctl deploy

# Du får: https://tap-and-go.fly.dev
```

> `fly.toml` er allerede konfigureret. Fly.io har gratis tier med auto-stop ved inaktivitet.

---

## Option 3: Railway (gratis, simpelt)

1. Gå til [railway.app](https://railway.app)
2. **New Project** → **Deploy from GitHub repo**
3. Vælg dit repo
4. Railway detecter automatisk Node.js og deployer
5. Under **Settings** → **Networking** → klik **Generate Domain**
6. Du får en URL som `https://tap-and-go-production.up.railway.app`

---

## Option 4: Docker (anywhere)

```bash
# Byg image
docker build -t tap-and-go .

# Kør lokalt
docker run -p 3000:3000 tap-and-go

# Eller deploy til enhver cloud med Docker support
```

---

## Efter deploy

- Del URL'en med dine spillere
- Spillerne åbner linket → Create/Join game → spil
- Ingen installation nødvendig for spillerne — det hele kører i browseren
- WebSocket-forbindelsen håndteres automatisk via `window.location.origin`
