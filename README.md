# Agendas

Coordinación de fecha y hora para una reunión entre grupos. Sin dependencias: sólo Node.js ≥ 18.

- **Admin** (`/admin`): crea el evento (título, lugar, rango de días y rango horario), habilita o deshabilita
  días en el calendario, ve el mapa de calor de disponibilidad, lee el buzón de sugerencias y confirma la fecha y hora.
- **Participantes** (`/?e=<id>`, el enlace que muestra el admin): ponen su nombre, eligen días en el calendario
  y marcan los horarios en que pueden. Pueden volver a editar desde el mismo navegador y dejar comentarios.

Al confirmar una fecha, los participantes la ven en un aviso y ya no pueden modificar su disponibilidad
(el admin puede "Reabrir").

## Uso local

```bash
cp .env.example .env      # y poné tu clave en ADMIN_KEY
npm start                 # o: node server.js
```

Abrí http://localhost:3000/admin.

## Configuración

Por variables de entorno o en `.env` (no se sube al repositorio):

| Variable    | Por defecto | Descripción                                   |
|-------------|-------------|-----------------------------------------------|
| `ADMIN_KEY` | —           | **Obligatoria**, mínimo 8 caracteres.         |
| `PORT`      | `3000`      | Puerto HTTP.                                  |
| `DATA_DIR`  | `./data`    | Carpeta donde se guarda `data.json`.          |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | — | Si están definidas, los datos van a Redis (Upstash) en vez de a `data.json`. También se aceptan `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`. |

Sin Redis, toda la información (eventos, respuestas, sugerencias) vive en `$DATA_DIR/data.json`.

## Despliegue

Siempre detrás de **HTTPS**: la clave de admin viaja en cada pedido.

### Vercel

Vercel no tiene disco persistente, así que ahí los datos van a Redis:

1. En el proyecto de Vercel: **Storage → Create Database → Upstash (Redis)**, plan gratuito, y conectala
   al proyecto. Eso define `KV_REST_API_URL` y `KV_REST_API_TOKEN` automáticamente.
2. **Settings → Environment Variables:** agregá `ADMIN_KEY` con tu clave.
3. Volvé a desplegar (push al repo, o **Deployments → Redeploy**). Las variables nuevas sólo se aplican en un despliegue nuevo.

Si falta algo, la API responde con un mensaje que dice qué falta.

### Servidor propio (VM / VPS)

```bash
sudo useradd --system --home /opt/agenda agenda
sudo git clone <url-del-repo> /opt/agenda
sudo mkdir -p /var/lib/agenda && sudo chown agenda: /var/lib/agenda
echo 'ADMIN_KEY=tu-clave' | sudo tee /opt/agenda/.env && sudo chmod 600 /opt/agenda/.env && sudo chown agenda: /opt/agenda/.env

sudo cp /opt/agenda/deploy/agenda.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now agenda

sudo cp /opt/agenda/deploy/nginx.conf /etc/nginx/sites-available/agenda   # editar el dominio
sudo ln -s /etc/nginx/sites-available/agenda /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d agenda.ejemplo.com
```

Si `node` no está en `/usr/bin/node` (por ejemplo, instalado con nvm), ajustá `ExecStart` en el `.service`.

Para actualizar: `cd /opt/agenda && sudo git pull && sudo systemctl restart agenda`.

### Render

`render.yaml` define el servicio con un disco persistente en `/var/data`. En Render: **New → Blueprint**,
elegí el repositorio y cargá `ADMIN_KEY` cuando lo pida. El disco requiere plan pago; sin disco, los datos
se pierden en cada despliegue.

## Respaldos

Con Redis (Upstash), los respaldos se manejan desde el panel de Upstash. Con archivo:

`scripts/backup.sh [DATA_DIR] [BACKUP_DIR]` copia `data.json` con fecha y conserva las últimas 30 copias.
Ejemplo con cron, todos los días a las 3:00:

```
0 3 * * * /opt/agenda/scripts/backup.sh /var/lib/agenda /var/backups/agenda
```

Para restaurar: detené el servicio, copiá el respaldo sobre `$DATA_DIR/data.json` y volvé a arrancarlo.
