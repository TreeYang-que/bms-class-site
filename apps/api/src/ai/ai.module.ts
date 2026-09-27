import { Module } from '@nestjs/common';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { AiConversationsController } from './ai-conversations.controller';
import { AiConversationsService } from './ai-conversations.service';
import { AiKnowledgeService } from './ai-knowledge.service';
import { AiController } from './ai.controller';
import { AiGatewayService } from './ai-gateway.service';
import { EmbeddingService } from './embedding.service';
import { LlmService } from './llm.service';

@Module({
  imports: [KnowledgeModule],
  controllers: [
    AiController,
    AiConversationsController,
  ],
  providers: [
    AiConversationsService,
    AiGatewayService,
    AiKnowledgeService,
    EmbeddingService,
    LlmService,
  ],
  exports: [AiGatewayService],
})
export class AiModule {}
