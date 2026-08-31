#!/bin/bash
# Build script for Render.com
# Устанавливает зависимости + сертификаты Минцифры в Python certifi bundle

set -e

echo "=== [1/3] Устанавливаем зависимости ==="
pip install -r requirements.txt

echo "=== [2/3] Скачиваем сертификаты Минцифры ==="
mkdir -p /tmp/russian_certs

# Скачиваем оба сертификата с Госуслуг
curl -fsSL "https://gu-st.ru/content/Other/doc/russian_trusted_root_ca.cer" \
     -o /tmp/russian_certs/root.cer

curl -fsSL "https://gu-st.ru/content/Other/doc/russian_trusted_sub_ca.cer" \
     -o /tmp/russian_certs/sub.cer

# Конвертируем из DER в PEM (Госуслуги отдают в DER)
openssl x509 -inform DER -in /tmp/russian_certs/root.cer \
             -out /tmp/russian_certs/root.pem 2>/dev/null || \
    cp /tmp/russian_certs/root.cer /tmp/russian_certs/root.pem

openssl x509 -inform DER -in /tmp/russian_certs/sub.cer \
             -out /tmp/russian_certs/sub.pem 2>/dev/null || \
    cp /tmp/russian_certs/sub.cer /tmp/russian_certs/sub.pem

echo "=== [3/3] Добавляем сертификаты в Python certifi bundle ==="
# Получаем путь к certifi ca-bundle
CERTIFI_PATH=$(python3 -c "import certifi; print(certifi.where())")
echo "certifi bundle: $CERTIFI_PATH"

# Проверяем, не добавлены ли сертификаты уже
if ! grep -q "Russian Trusted Root CA" "$CERTIFI_PATH"; then
    echo "" >> "$CERTIFI_PATH"
    echo "# Russian Trusted Root CA (Mincifry)" >> "$CERTIFI_PATH"
    cat /tmp/russian_certs/root.pem >> "$CERTIFI_PATH"
    echo "  ✓ Root CA добавлен"
else
    echo "  Root CA уже присутствует — пропуск"
fi

if ! grep -q "Russian Trusted Sub CA" "$CERTIFI_PATH"; then
    echo "" >> "$CERTIFI_PATH"
    echo "# Russian Trusted Sub CA (Mincifry)" >> "$CERTIFI_PATH"
    cat /tmp/russian_certs/sub.pem >> "$CERTIFI_PATH"
    echo "  ✓ Sub CA добавлен"
else
    echo "  Sub CA уже присутствует — пропуск"
fi

echo ""
echo "✅ Сборка завершена! Сертификаты Минцифры установлены."
