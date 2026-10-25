# Dressing

App personnelle de dressing pour iPhone (PWA) : pièces, tenues, suggestions d'associations, pièces oubliées.

- 100 % gratuite : pas de serveur, pas d'API, pas de clé.
- Les données (photos, pièces, tenues) restent **uniquement sur le téléphone** (IndexedDB). Ce dépôt ne contient que le code.
- HTML / CSS / JavaScript simples, sans étape de build ni dépendance.

## Utiliser l'app

1. Ouvrir l'adresse GitHub Pages dans **Safari** sur l'iPhone.
2. Partager → **Sur l'écran d'accueil**.
3. Toujours ouvrir l'app depuis l'icône : ses données sont séparées de celles de l'onglet Safari.
4. Exporter régulièrement une sauvegarde (Réglages → Exporter la sauvegarde) dans Fichiers / iCloud Drive.

## Tester en local

```bash
python3 serve.py
```

Puis ouvrir l'adresse affichée sur l'iPhone (même Wi-Fi).

## Publier une mise à jour

À chaque changement de code : incrémenter `CACHE` dans `sw.js` et le paramètre `?v=` des fichiers (index.html, js/app.js, js/suggest.js), puis pousser sur `main`. GitHub Pages republie automatiquement ; l'app se met à jour au lancement suivant.

## Organisation

- `index.html` : coquille de l'app et barre d'onglets
- `css/app.css` : styles
- `js/app.js` : écrans et interactions
- `js/db.js` : stockage local (IndexedDB)
- `js/color.js` : couleur dominante des photos et règles d'harmonie
- `js/suggest.js` : moteur de suggestions de tenues
- `sw.js`, `manifest.webmanifest`, `icons/` : installation et fonctionnement hors ligne
