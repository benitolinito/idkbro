FROM nginx:1.27-alpine

COPY website/nginx.conf /etc/nginx/conf.d/default.conf
COPY website/index.html /usr/share/nginx/html/index.html
COPY website/styles.css /usr/share/nginx/html/styles.css
COPY website/script.js /usr/share/nginx/html/script.js
COPY website/assets /usr/share/nginx/html/assets

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
