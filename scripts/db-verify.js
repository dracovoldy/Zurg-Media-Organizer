const { PrismaClient } = require('@prisma/client');

(async () => {
  const prisma = new PrismaClient();
  try {
    const d = await prisma.directory.count();
    const f = await prisma.file.count();
    console.log('directories:', d, 'files:', f);
  } catch (e) {
    console.error('Error verifying DB:', e);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
