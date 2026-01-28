#!/usr/bin/env python3
"""Script para verificar dados de telemetria no MongoDB."""

import os
import sys
from datetime import datetime, timedelta
from pymongo import MongoClient
from pymongo.errors import ConnectionFailure
from dotenv import load_dotenv

def main():
    # Carregar variáveis de ambiente
    load_dotenv()
    mongodb_uri = os.getenv("MONGODB_URI")
    customer_id = os.getenv("KYNEX_TELEMETRY_CSV_CUSTOMER_ID", "U_f9ab7791-368f-4ab4-80db-6c556c7dac1d")
    
    if not mongodb_uri:
        print("❌ MONGODB_URI não definido")
        sys.exit(1)
    
    try:
        client = MongoClient(mongodb_uri, serverSelectionTimeoutMS=5000)
        client.server_info()  # Teste a conexão
        db = client["kynex"]
        
        col = db["customer_telemetry_15m"]
        
        # Obter últimas 10 linhas
        latest = list(col.find(
            {"customer_id": customer_id},
            {"_id": 0, "ts": 1, "watts": 1}
        ).sort("ts", -1).limit(10))
        
        if not latest:
            print(f"❌ Nenhum dado encontrado para customer_id={customer_id}")
            sys.exit(1)
        
        print(f"✅ Últimos dados de telemetria para {customer_id}:")
        print("-" * 60)
        
        for doc in reversed(latest):
            ts = doc.get("ts")
            watts = doc.get("watts", "N/A")
            print(f"  {ts} -> {watts}W")
        
        # Verificar gap entre o último dado e agora
        last_ts = latest[-1]["ts"]
        now = datetime.utcnow()
        gap = now - last_ts
        
        print("-" * 60)
        print(f"⏱️  Última leitura: {last_ts}")
        print(f"⏱️  Agora (UTC):    {now}")
        print(f"⏱️  Gap:           {gap}")
        
        if gap > timedelta(minutes=20):
            print(f"⚠️  Gap de {gap.total_seconds()/60:.0f} minutos - esperado ~15min")
        else:
            print(f"✅ Gap aceitável")
            
    except ConnectionFailure:
        print("❌ Não conseguiu ligar ao MongoDB")
        sys.exit(1)
    except Exception as e:
        print(f"❌ Erro: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
