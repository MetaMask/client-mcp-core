#import "ObjCExceptionCatcher.h"

@implementation ObjCExceptionCatcher

+ (BOOL)tryBlock:(void (NS_NOESCAPE ^)(void))block
           error:(NSError * _Nullable __autoreleasing * _Nullable)error {
    @try {
        block();
        return YES;
    } @catch (NSException *exception) {
        if (error) {
            *error = [NSError errorWithDomain:@"AgentDeviceRunner.ObjCException"
                                         code:1
                                     userInfo:@{
                NSLocalizedDescriptionKey: [NSString stringWithFormat:@"%@: %@",
                                            exception.name, exception.reason ?: @"(no reason)"],
                @"ExceptionName": exception.name,
                @"ExceptionReason": exception.reason ?: @"(no reason)",
            }];
        }
        return NO;
    }
}

@end
