#!/bin/bash
# ============================================================
# Установка сертификатов Минцифры России для Funko Stop сервера
# Запустить от root: sudo bash install_certs.sh
# ============================================================

set -e

echo "=== Установка сертификатов Минцифры (Russian Trusted CA) ==="

WORK_DIR="/tmp/russian_certs"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

# Шаг 1: Скачиваем сертификаты
echo "[1/4] Скачиваем сертификаты с Госуслуг..."
curl -fsSL "https://gu-st.ru/content/Other/doc/russian_trusted_root_ca.cer" -o russian_trusted_root_ca.cer
curl -fsSL "https://gu-st.ru/content/Other/doc/russian_trusted_sub_ca.cer" -o russian_trusted_sub_ca.cer

# Шаг 2: Проверяем формат и конвертируем DER -> PEM если нужно
echo "[2/4] Проверяем и конвертируем формат..."
for cert in russian_trusted_root_ca.cer russian_trusted_sub_ca.cer; do
    base="${cert%.*}"
    if openssl x509 -in "$cert" -noout -text >/dev/null 2>&1; then
        echo "  $cert уже в формате PEM"
        cp "$cert" "${base}.pem"
    else
        echo "  $cert в формате DER — конвертируем..."
        openssl x509 -inform DER -in "$cert" -out "${base}.pem"
        echo "  Конвертирован в ${base}.pem"
    fi
done

# Шаг 3: Устанавливаем в системное хранилище (Debian/Ubuntu)
echo "[3/4] Устанавливаем в системное хранилище..."
cp russian_trusted_root_ca.pem /usr/local/share/ca-certificates/russian_trusted_root_ca.crt
cp russian_trusted_sub_ca.pem /usr/local/share/ca-certificates/russian_trusted_sub_ca.crt
update-ca-certificates
echo "  Системные сертификаты обновлены."

# Шаг 4: Создаём bundle для Python (certifi не доверяет системному хранилищу)
echo "[4/4] Создаём CA bundle для Python/httpx..."
BUNDLE_PATH="/etc/ssl/russian-trusted-ca-bundle.pem"
cat russian_trusted_root_ca.pem russian_trusted_sub_ca.pem > "$BUNDLE_PATH"

# Добавляем к стандартному certifi bundle
CERTIFI_PATH=$(python3 -c "import certifi; print(certifi.where())" 2>/dev/null || echo "")
if [ -n "$CERTIFI_PATH" ]; then
    # Делаем бэкап
    cp "$CERTIFI_PATH" "${CERTIFI_PATH}.backup"
    cat russian_trusted_root_ca.pem >> "$CERTIFI_PATH"
    cat russian_trusted_sub_ca.pem >> "$CERTIFI_PATH"
    echo "  Добавлены в certifi: $CERTIFI_PATH (бэкап: ${CERTIFI_PATH}.backup)"
else
    echo "  certifi не найден — будет использован BUNDLE_PATH"
fi

# Записываем путь к bundle для ручного использования
echo "$BUNDLE_PATH" > /etc/russian_ca_bundle_path.txt

echo ""
echo "=== Проверка установки ==="
curl -sv https://mddc.tbank.ru/ 2>&1 | grep -E "SSL certificate verify|subject:|issuer:" | head -5 || echo "  (проверка через curl)"

echo ""
echo "✅ Готово! Сертификаты установлены."
echo ""
echo "Если Python/httpx всё ещё не доверяет — добавьте в переменные окружения:"
echo "  export REQUESTS_CA_BUNDLE=$BUNDLE_PATH"
echo "  export SSL_CERT_FILE=$BUNDLE_PATH"
echo "  export HTTPX_CA_BUNDLE=$BUNDLE_PATH"
echo ""
echo "Или используйте в .env файле приложения."

cd /
rm -rf "$WORK_DIR"
