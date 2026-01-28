#!/usr/bin/env node
/**
 * interactive.js
 * Script interativo para testar faturas com imagem/PDF
 * 
 * Uso:
 *   npm run interactive
 *   ou
 *   node interactive.js
 */

import Tesseract from 'tesseract.js';
import { processInvoice } from './invoiceAI.js';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import pdfParse from 'pdf-parse';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function extractTextFromPdf(pdfPath) {
  console.log('📄 Processando PDF...');
  
  try {
    const pdfBuffer = fs.readFileSync(pdfPath);
    const pdfData = await pdfParse(pdfBuffer);
    
    // Extrai texto do PDF
    if (pdfData.text && pdfData.text.trim().length > 0) {
      console.log('✅ Texto extraído do PDF!\n');
      return pdfData.text;
    }

    throw new Error('Nenhum texto encontrado no PDF');
  } catch (error) {
    throw new Error(`Erro ao processar PDF: ${error.message}`);
  }
}

async function extractAndProcess(filePath) {
  const absolutePath = path.resolve(filePath);
  
  // Validar ficheiro
  if (!fs.existsSync(absolutePath)) {
    console.error(`❌ Ficheiro não encontrado: ${absolutePath}`);
    return false;
  }

  const ext = path.extname(absolutePath).toLowerCase();
  if (!['.jpg', '.jpeg', '.png', '.pdf', '.gif', '.bmp', '.webp'].includes(ext)) {
    console.error(`❌ Formato não suportado: ${ext}`);
    console.log('   Formatos aceitos: JPG, PNG, PDF, GIF, BMP, WEBP');
    return false;
  }

  console.log(`\n📷 Processando: ${path.basename(absolutePath)}`);

  try {
    let ocrText;

    // Se for PDF, extrai texto diretamente
    if (ext === '.pdf') {
      ocrText = await extractTextFromPdf(absolutePath);
    } else {
      // Para imagens, faz OCR
      console.log('⏳ A fazer OCR (isto pode demorar um minuto)...\n');
      
      const result = await Tesseract.recognize(absolutePath, 'por+eng', {
        logger: (m) => {
          if (m.status === 'recognizing') {
            process.stdout.write(`\r  ⏳ Progresso: ${Math.round(m.progress * 100)}%`);
          }
        }
      });

      ocrText = result.data.text;
      console.log(`\n✅ OCR Completo!\n`);
    }

    // Processar com o modelo
    const invoiceResult = processInvoice(ocrText);

    // Mostrar resultado
    console.log('='.repeat(70));
    console.log('📊 RESULTADO DA ANÁLISE');
    console.log('='.repeat(70));
    console.log();

    if (!invoiceResult.success) {
      console.log('⚠️  Não foi detectada uma fatura');
      console.log(`Confiança: ${invoiceResult.data.confidence}%`);
      console.log(`Qualidade: ${invoiceResult.quality}\n`);
      console.log('💡 Dica: Certifique-se que o documento é uma fatura clara');
      return true;
    }

    console.log(`✅ Fatura Processada com Sucesso!`);
    console.log(`📈 Qualidade: ${invoiceResult.quality}`);
    console.log(`📊 Confiança: ${invoiceResult.data.confidence}%\n`);

    console.log('📋 Dados Extraídos:');
    console.log('─'.repeat(70));
    console.log(`  Referência:    ${invoiceResult.data.reference}`);
    console.log(`  Data:          ${invoiceResult.data.date}`);
    console.log(`  Valor:         ${invoiceResult.data.amount ? '€' + invoiceResult.data.amount.toFixed(2) : 'N/A'}`);
    console.log(`  Vencimento:    ${invoiceResult.data.dueDate || 'N/A'}`);
    console.log(`  Fornecedor:    ${invoiceResult.data.provider}`);
    console.log(`  Email:         ${invoiceResult.data.email || 'N/A'}`);
    console.log(`  NIF:           ${invoiceResult.data.nif || 'N/A'}`);
    console.log(`  IBAN:          ${invoiceResult.data.iban || 'N/A'}`);
    console.log();

    console.log('📄 JSON (para guardar/API):');
    console.log('─'.repeat(70));
    console.log(JSON.stringify(invoiceResult.data, null, 2));
    console.log();

    return true;
  } catch (error) {
    console.error(`\n❌ Erro ao processar: ${error.message}`);
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length > 0) {
    // Modo direto: node interactive.js /caminho/fatura.jpg
    await extractAndProcess(args[0]);
    rl.close();
    return;
  }

  // Modo interativo
  console.log('╔' + '═'.repeat(68) + '╗');
  console.log('║' + ' '.repeat(15) + '🧪 TESTE DE EXTRAÇÃO DE FATURAS' + ' '.repeat(21) + '║');
  console.log('╚' + '═'.repeat(68) + '╝');
  console.log();

  let continuar = true;

  while (continuar) {
    const filePath = await question('\n📁 Caminho do ficheiro (JPG/PNG/PDF): ');

    if (filePath.trim() === '') {
      console.log('❌ Caminho vazio');
      continue;
    }

    const success = await extractAndProcess(filePath.trim());

    if (success) {
      const novaTeste = await question('\n🔄 Testar outro ficheiro? (s/n): ');
      continuar = novaTeste.toLowerCase() === 's';
    }
  }

  console.log('\n👋 Até logo!');
  rl.close();
}

main().catch((err) => {
  console.error('Erro:', err);
  process.exit(1);
});
